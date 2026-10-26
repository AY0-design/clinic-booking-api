const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { pool } = require('./db');

const API_KEY = process.env.API_KEY;
const RATE_LIMIT = 5;
const RATE_WINDOW_S = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const app = express();
app.disable('x-powered-by');

// ---- CORS (so the API can also be called from other origins) -------------
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Idempotency-Key',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'Retry-After',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- Web page (public; the API itself is what is protected) --------------
const page = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
app.get('/', (req, res) => {
  const key = JSON.stringify(API_KEY || '').replace(/</g, '\\u003c');
  res.type('html').send(page.replace('/*__API_KEY__*/', `window.API_KEY=${key};`));
});
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/favicon.ico', (req, res) => res.sendStatus(204));

// ---- Level 2: API key on every API request --------------------------------
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
app.use((req, res, next) => {
  const given = req.get('X-API-Key');
  if (!API_KEY || !given || !safeEqual(given, API_KEY)) {
    return res.status(401).json({ error: 'missing or invalid API key' });
  }
  next();
});

app.use(express.json({ limit: '1mb' }));

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const iso = (d) => new Date(d).toISOString();
const bookingOut = (r) => ({
  id: r.id,
  slot_id: r.slot_id,
  name: r.name,
  email: r.email,
  status: r.status,
  created_at: iso(r.created_at),
});

// ---- POST /reset -----------------------------------------------------------
app.post('/reset', wrap(async (req, res) => {
  const slots = req.body && req.body.slots;
  if (!Array.isArray(slots)) return res.status(400).json({ error: 'slots must be an array' });
  const seen = new Set();
  for (const s of slots) {
    const ok = s && typeof s.id === 'string' && s.id && typeof s.provider === 'string' &&
      !isNaN(Date.parse(s.start)) && !isNaN(Date.parse(s.end));
    if (!ok || seen.has(s.id)) return res.status(400).json({ error: 'invalid slot: ' + JSON.stringify(s && s.id) });
    seen.add(s.id);
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('TRUNCATE slots, bookings, idempotency, attempts');
    for (const s of slots) {
      await c.query('INSERT INTO slots (id, provider, start_at, end_at) VALUES ($1,$2,$3,$4)',
        [s.id, s.provider, s.start, s.end]);
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  res.json({ ok: true, slots: slots.length });
}));

// ---- GET /slots ------------------------------------------------------------
app.get('/slots', wrap(async (req, res) => {
  const params = [];
  let where = '';
  if (typeof req.query.provider === 'string') {
    params.push(req.query.provider);
    where = 'WHERE s.provider = $1';
  }
  const { rows } = await pool.query(
    `SELECT s.id, s.provider, s.start_at, s.end_at,
            NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
       FROM slots s ${where}
      ORDER BY s.start_at, s.id`, params);
  res.json({
    slots: rows.map((r) => ({
      id: r.id, provider: r.provider, start: iso(r.start_at), end: iso(r.end_at), available: r.available,
    })),
  });
}));

// ---- POST /bookings (levels 1-5) -------------------------------------------
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

// Everything runs in ONE transaction. Locks taken (in this order):
//   1. advisory lock on the Idempotency-Key  -> two identical retries can't both run
//   2. advisory lock on the email            -> rate-limit count + insert is atomic
// The slot itself is protected by the unique index, not by a lock.
async function createBooking(c, body, idemKey) {
  const bodyObj = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const hash = crypto.createHash('sha256').update(canonical(body === undefined ? null : body)).digest('hex');

  if (idemKey) {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['idem:' + idemKey]);
    const { rows } = await c.query('SELECT body_hash, status, response FROM idempotency WHERE key = $1', [idemKey]);
    if (rows.length) {
      if (rows[0].body_hash !== hash) {
        return { status: 422, json: { error: 'Idempotency-Key was already used with a different request body' } };
      }
      return { status: rows[0].status, json: rows[0].response };
    }
  }

  const done = async (status, json) => {
    if (idemKey) {
      await c.query('INSERT INTO idempotency (key, body_hash, status, response) VALUES ($1,$2,$3,$4)',
        [idemKey, hash, status, JSON.stringify(json)]);
    }
    return { status, json };
  };

  // Level 5: rate limit by email, counting every attempt (failed ones too).
  const rawEmail = typeof bodyObj.email === 'string' ? bodyObj.email.trim().toLowerCase() : '';
  if (rawEmail) {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['rl:' + rawEmail]);
    await c.query(`DELETE FROM attempts WHERE at < clock_timestamp() - interval '10 minutes'`);
    const { rows } = await c.query(
      `SELECT count(*)::int AS n,
              CEIL(EXTRACT(EPOCH FROM (min(at) + make_interval(secs => $2) - clock_timestamp()))) AS wait
         FROM attempts
        WHERE email = $1 AND at > clock_timestamp() - make_interval(secs => $2)`,
      [rawEmail, RATE_WINDOW_S]);
    if (rows[0].n >= RATE_LIMIT) {
      const wait = Math.max(1, Math.min(RATE_WINDOW_S, Number(rows[0].wait) || RATE_WINDOW_S));
      return { status: 429, json: { error: 'too many booking attempts, slow down' }, retryAfter: wait };
    }
    await c.query('INSERT INTO attempts (email) VALUES ($1)', [rawEmail]);
  }

  // Level 2: validation
  const slotId = typeof bodyObj.slot_id === 'string' ? bodyObj.slot_id.trim() : '';
  const name = typeof bodyObj.name === 'string' ? bodyObj.name.trim() : '';
  if (!slotId) return done(400, { error: 'slot_id is required' });
  if (!name) return done(400, { error: 'name is required' });
  if (!rawEmail) return done(400, { error: 'email is required' });
  if (!EMAIL_RE.test(rawEmail)) return done(400, { error: 'email is not valid' });

  const slot = (await c.query('SELECT id, start_at FROM slots WHERE id = $1', [slotId])).rows[0];
  if (!slot) return done(404, { error: 'slot not found' });
  if (new Date(slot.start_at).getTime() <= Date.now()) return done(400, { error: 'slot has already started' });

  // Level 3: the unique index decides who wins a race.
  await c.query('SAVEPOINT ins');
  try {
    const { rows } = await c.query(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ($1,$2,$3,$4,'confirmed') RETURNING *`,
      [crypto.randomUUID(), slotId, name, rawEmail]);
    return done(201, bookingOut(rows[0]));
  } catch (e) {
    if (e.code !== '23505') throw e;
    await c.query('ROLLBACK TO SAVEPOINT ins');
    return done(409, { error: 'slot is already booked' });
  }
}

app.post('/bookings', wrap(async (req, res) => {
  const idemKey = (req.get('Idempotency-Key') || '').trim() || null;
  const c = await pool.connect();
  let result;
  try {
    await c.query('BEGIN');
    result = await createBooking(c, req.body, idemKey);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  if (result.retryAfter) res.set('Retry-After', String(result.retryAfter));
  res.status(result.status).json(result.json);
}));

// ---- GET /bookings?email=&limit=&cursor= (level 4) -------------------------
app.get('/bookings', wrap(async (req, res) => {
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (!email) return res.status(400).json({ error: 'email is required' });

  let limit = 10;
  if (req.query.limit !== undefined) {
    if (!/^\d+$/.test(String(req.query.limit))) return res.status(400).json({ error: 'limit must be an integer from 1 to 50' });
    limit = Number(req.query.limit);
    if (limit < 1 || limit > 50) return res.status(400).json({ error: 'limit must be an integer from 1 to 50' });
  }

  let after = 0;
  if (req.query.cursor !== undefined && req.query.cursor !== '') {
    try {
      const decoded = Buffer.from(String(req.query.cursor), 'base64url').toString('utf8');
      if (!/^\d+$/.test(decoded)) throw new Error();
      after = Number(decoded);
    } catch {
      return res.status(400).json({ error: 'invalid cursor' });
    }
  }

  // Ask for one extra row to know whether another page exists.
  const { rows } = await pool.query(
    `SELECT * FROM bookings WHERE email = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [email, after, limit + 1]);
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? Buffer.from(String(page[page.length - 1].seq)).toString('base64url') : null;
  res.json({ bookings: page.map(bookingOut), next_cursor: next });
}));

// ---- GET / DELETE /bookings/:id ---------------------------------------------
app.get('/bookings/:id', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'booking not found' });
  res.json(bookingOut(rows[0]));
}));

app.delete('/bookings/:id', wrap(async (req, res) => {
  // Atomic: only one of many simultaneous cancels can flip confirmed -> cancelled.
  const upd = await pool.query(
    `UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING *`,
    [req.params.id]);
  if (upd.rows.length) return res.json(bookingOut(upd.rows[0]));
  const { rows } = await pool.query('SELECT 1 FROM bookings WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'booking not found' });
  res.status(409).json({ error: 'booking is already cancelled' });
}));

// ---- Fallbacks --------------------------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

module.exports = app;
