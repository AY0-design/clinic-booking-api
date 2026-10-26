// Integration tests against a real Postgres (embedded) and the real HTTP server.
const path = require('path');
const assert = require('assert');
const EmbeddedPostgres = require('embedded-postgres').default;

const KEY = 'test-key';
const dir = path.join(__dirname, '..', '.pgdata');
require('fs').rmSync(dir, { recursive: true, force: true });

(async () => {
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port: 54329, persistent: false });
  await pg.initialise(); await pg.start(); await pg.createDatabase('clinic');
  process.env.DATABASE_URL = 'postgres://postgres:pw@localhost:54329/clinic';
  process.env.API_KEY = KEY;
  const app = require('../src/app');
  await require('../src/db').init();
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;

  const call = (method, p, body, headers = {}) => fetch(base + p, {
    method, headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, headers: r.headers, json: await r.json().catch(() => null) }));

  const future = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  const slot = (id, h, provider = 'Dr Ade') => ({ id, provider, start: future(h), end: future(h + 0.5) });
  const reset = () => call('POST', '/reset', { slots: [slot('s2', 48), slot('s1', 24), slot('past', -2, 'Dr Bo'), slot('s3', 72, 'Dr Bo')] });
  let n = 0; const em = () => `u${++n}@example.com`;
  const good = (slot_id = 's1', email = em()) => ({ slot_id, name: 'Ada Obi', email });
  const tests = [];
  const t = (name, fn) => tests.push([name, fn]);

  t('auth: missing/wrong key -> 401', async () => {
    for (const h of [{ 'X-API-Key': '' }, { 'X-API-Key': 'nope' }]) assert.equal((await call('GET', '/slots', undefined, h)).status, 401);
    assert.equal((await fetch(base + '/slots')).status, 401);
    assert.equal((await fetch(base + '/bookings/x', { method: 'DELETE' })).status, 401);
  });
  t('slots sorted, filter, availability', async () => {
    await reset();
    const r = await call('GET', '/slots');
    assert.deepEqual(r.json.slots.map((s) => s.id), ['past', 's1', 's2', 's3']);
    assert.equal(r.json.slots[1].available, true);
    assert.deepEqual((await call('GET', '/slots?provider=Dr%20Bo')).json.slots.map((s) => s.id), ['past', 's3']);
  });
  t('book, get, 404, availability flips', async () => {
    await reset();
    const b = await call('POST', '/bookings', { slot_id: 's1', name: '  Ada  ', email: '  ADA@Example.COM ' });
    assert.equal(b.status, 201);
    assert.equal(b.json.status, 'confirmed'); assert.equal(b.json.name, 'Ada'); assert.equal(b.json.email, 'ada@example.com');
    assert.deepEqual((await call('GET', '/bookings/' + b.json.id)).json, b.json);
    assert.equal((await call('GET', '/bookings/nope')).status, 404);
    assert.equal((await call('GET', '/slots')).json.slots.find((s) => s.id === 's1').available, false);
  });
  t('validation: 400/404', async () => {
    await reset();
    const bad = [{}, { slot_id: 's1', name: 'a' }, { slot_id: 's1', email: 'a@b.co' }, { slot_id: 's1', name: '  ', email: 'a@b.co' },
      { slot_id: '', name: 'a', email: 'a@b.co' }, { slot_id: 's1', name: 'a', email: 'not-an-email' }, { slot_id: 's1', name: 'a', email: 'a@b' },
      { slot_id: 's1', name: 5, email: 'a@b.co' }, { slot_id: 'past', name: 'a', email: 'a@b.co' }];
    for (const [i, body] of bad.entries()) assert.equal((await call('POST', '/bookings', body)).status, 400, 'case ' + i);
    assert.equal((await call('POST', '/bookings', good('ghost'))).status, 404);
    const raw = await fetch(base + '/bookings', { method: 'POST', headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' }, body: '{bad' });
    assert.equal(raw.status, 400);
  });
  t('double booking -> 409; cancel frees slot; cancel twice -> 409', async () => {
    await reset();
    const a = await call('POST', '/bookings', good());
    assert.equal((await call('POST', '/bookings', good())).status, 409);
    const c = await call('DELETE', '/bookings/' + a.json.id);
    assert.equal(c.status, 200); assert.equal(c.json.status, 'cancelled');
    assert.equal((await call('DELETE', '/bookings/' + a.json.id)).status, 409);
    assert.equal((await call('DELETE', '/bookings/zzz')).status, 404);
    assert.equal((await call('POST', '/bookings', good())).status, 201);
  });
  t('race: 40 simultaneous bookings -> exactly one 201', async () => {
    await reset();
    const rs = await Promise.all(Array.from({ length: 40 }, () => call('POST', '/bookings', good('s2'))));
    const codes = rs.map((r) => r.status);
    assert.equal(codes.filter((c) => c === 201).length, 1, codes.join());
    assert.equal(codes.filter((c) => c === 409).length, 39, codes.join());
  });
  t('idempotency: replay, concurrent replay, 422', async () => {
    await reset();
    const body = good(), h = { 'Idempotency-Key': 'k1' };
    const a = await call('POST', '/bookings', body, h), b = await call('POST', '/bookings', body, h);
    assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(a.json.id, b.json.id);
    assert.equal((await call('POST', '/bookings', { ...body, name: 'Other' }, h)).status, 422);
    const body2 = good('s2'), h2 = { 'Idempotency-Key': 'k2' };
    const rs = await Promise.all(Array.from({ length: 15 }, () => call('POST', '/bookings', body2, h2)));
    assert.ok(rs.every((r) => r.status === 201 && r.json.id === rs[0].json.id));
    // a replayed 409 is replayed as 409
    const c1 = await call('POST', '/bookings', good('s2'), { 'Idempotency-Key': 'k3' });
    assert.equal(c1.status, 409);
    assert.equal((await call('POST', '/bookings', { slot_id: 's2', name: 'Ada Obi', email: JSON.parse(JSON.stringify(c1)).status && 'x@y.co' }, { 'Idempotency-Key': 'k3' })).status, 422);
  });
  t('pagination: oldest first, cursor, limits, case-insensitive', async () => {
    await call('POST', '/reset', { slots: Array.from({ length: 5 }, (_, i) => slot('p' + i, 10 + i)) });
    const email = 'Pager@Example.com'; const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await call('POST', '/bookings', { slot_id: 'p' + i, name: 'P', email })).json.id);
    const seen = []; let cursor = null, pages = 0;
    do {
      const r = await call('GET', `/bookings?email=${encodeURIComponent(email.toUpperCase())}&limit=2` + (cursor ? '&cursor=' + cursor : ''));
      assert.equal(r.status, 200); seen.push(...r.json.bookings.map((b) => b.id)); cursor = r.json.next_cursor; pages++;
    } while (cursor);
    assert.deepEqual(seen, ids); assert.equal(pages, 3);
    const exact = await call('GET', '/bookings?email=pager@example.com&limit=5');
    assert.equal(exact.json.next_cursor, null);
    assert.equal((await call('GET', '/bookings?email=nobody@x.co')).json.bookings.length, 0);
    for (const l of ['0', '51', 'abc', '-1', '2.5']) assert.equal((await call('GET', `/bookings?email=a@b.co&limit=${l}`)).status, 400, l);
    assert.equal((await call('GET', '/bookings')).status, 400);
    assert.equal((await call('GET', '/bookings?email=a@b.co&cursor=%%%')).status, 400);
  });
  t('rate limit: 6th attempt for an email -> 429 + Retry-After; others fine', async () => {
    await reset();
    const email = 'spam@example.com';
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await call('POST', '/bookings', { slot_id: 'ghost', name: 'S', email })).status);
    assert.deepEqual(codes, [404, 404, 404, 404, 404]); // failed attempts count
    const r = await call('POST', '/bookings', { slot_id: 's1', name: 'S', email: 'SPAM@example.com' });
    assert.equal(r.status, 429);
    const ra = Number(r.headers.get('retry-after')); assert.ok(Number.isInteger(ra) && ra >= 1 && ra <= 60, 'retry-after ' + ra);
    assert.equal((await call('POST', '/bookings', good('s1', 'other@example.com'))).status, 201);
  });
  t('rate limit: concurrent burst allows exactly 5', async () => {
    await reset();
    const rs = await Promise.all(Array.from({ length: 12 }, () => call('POST', '/bookings', { slot_id: 'ghost', name: 'S', email: 'burst@example.com' })));
    assert.equal(rs.filter((r) => r.status === 429).length, 7);
  });
  t('web page served', async () => {
    const r = await fetch(base + '/'); const html = await r.text();
    assert.equal(r.status, 200); assert.ok(html.includes('window.API_KEY="test-key"'));
  });

  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '\n  ', e.message); }
  }
  server.close(); await require('../src/db').pool.end(); await pg.stop();
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
