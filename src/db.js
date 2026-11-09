const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  // An idle client died (e.g. Neon scaled to zero). The pool replaces it.
  console.error('pg pool error:', err.message);
});

// Schema is created idempotently on boot so a fresh database just works.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (
  id        TEXT PRIMARY KEY,
  provider  TEXT NOT NULL,
  start_raw TEXT NOT NULL,          -- returned exactly as the client sent it
  end_raw   TEXT NOT NULL,
  start_at  TIMESTAMPTZ NOT NULL,   -- used for ordering and the "already started" check
  end_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS slots_start_idx ON slots (start_at, id);
CREATE INDEX IF NOT EXISTS slots_provider_idx ON slots (provider);

CREATE TABLE IF NOT EXISTS bookings (
  seq        BIGSERIAL UNIQUE,       -- monotonic order for keyset pagination
  id         TEXT PRIMARY KEY,
  slot_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,          -- stored lower-cased
  status     TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Level 3: the database itself guarantees one confirmed booking per slot,
-- so two simultaneous requests can never both win.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_confirmed_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS bookings_email_seq_idx ON bookings (email, seq);

-- Level 4: stored responses for Idempotency-Key replays.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status_code  INT  NOT NULL,
  body         JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Level 5: one row per booking attempt, for a per-email sliding window.
CREATE TABLE IF NOT EXISTS booking_attempts (
  id    BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS booking_attempts_email_at_idx ON booking_attempts (email, at);
`;

async function migrate() {
  // Serialise migrations if several instances boot at once.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(42424242)');
    await client.query(SCHEMA);
  } finally {
    await client.query('SELECT pg_advisory_unlock(42424242)').catch(() => {});
    client.release();
  }
}

// Run fn inside a transaction; commits on success, rolls back on throw.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, migrate, tx };
