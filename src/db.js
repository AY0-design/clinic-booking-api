const { Pool } = require('pg');

const url = process.env.DATABASE_URL;
const local = /@(localhost|127\.0\.0\.1)(:|\/|$)/.test(url || '');

const pool = new Pool({
  connectionString: url,
  ssl: local || process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX) || (process.env.VERCEL ? 3 : 10),
});

// Schema. The partial unique index is what makes double-booking impossible:
// the database itself refuses a second *confirmed* booking for the same slot,
// no matter how many requests race.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (
  id        TEXT PRIMARY KEY,
  provider  TEXT NOT NULL,
  start_at  TIMESTAMPTZ NOT NULL,
  end_at    TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  seq        BIGSERIAL UNIQUE,
  id         TEXT PRIMARY KEY,
  slot_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS bookings_email_seq ON bookings (email, seq);
CREATE TABLE IF NOT EXISTS idempotency (
  key       TEXT PRIMARY KEY,
  body_hash TEXT NOT NULL,
  status    INT  NOT NULL,
  response  JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  email TEXT NOT NULL,
  at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS attempts_email_at ON attempts (email, at);
`;

async function init() {
  const c = await pool.connect();
  try {
    // xact-level lock: safe behind a transaction-pooling proxy (Neon's pooled URL)
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(42)');
    await c.query(SCHEMA);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}

module.exports = { pool, init };
