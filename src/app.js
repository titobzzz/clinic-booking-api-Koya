const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { pool, tx } = require('./db');
const {
  isValidEmail, isNonEmptyString, parseIsoDate, normaliseEmail,
  hashBody, encodeCursor, decodeCursor,
} = require('./validation');

const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 5);
const RATE_LIMIT_WINDOW_SEC = Number(process.env.RATE_LIMIT_WINDOW_SEC || 60);

// Advisory-lock namespaces (first int of the two-int form).
const LOCK_IDEMPOTENCY = 1;
const LOCK_RATE_EMAIL = 2;

class HttpError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function toBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toSlot(row) {
  return {
    id: row.id,
    provider: row.provider,
    start: row.start_raw,
    end: row.end_raw,
    available: row.available,
  };
}

function createApp({ apiKey }) {
  if (!apiKey) throw new Error('API_KEY is not set');
  const apiKeyBuf = Buffer.from(apiKey);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(cors({
    allowedHeaders: ['Content-Type', 'X-API-Key', 'Idempotency-Key'],
    exposedHeaders: ['Retry-After'],
  }));

  // The booking web page. A browser navigation can't send X-API-Key,
  // so the page asks the user for the key and sends it on every API call.
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

  // Unauthenticated liveness probe for the host.
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // ---- Level 2: API key on every request ---------------------------------
  app.use((req, res, next) => {
    const given = req.get('X-API-Key');
    const buf = Buffer.from(given || '');
    if (!given || buf.length !== apiKeyBuf.length || !crypto.timingSafeEqual(buf, apiKeyBuf)) {
      return res.status(401).json({ error: 'missing or invalid API key' });
    }
    next();
  });

  // Parse bodies only after auth, so a bad key always gets 401 first.
  // Any Content-Type is accepted as JSON (clients don't always send it).
  app.use(express.json({ type: () => true, limit: '100kb', strict: true }));

  // ---- POST /reset (Level 1) ----------------------------------------------
  app.post('/reset', wrap(async (req, res) => {
    const slots = req.body && req.body.slots;
    if (!Array.isArray(slots)) throw new HttpError(400, 'slots must be an array');

    const seen = new Set();
    const rows = slots.map((s, i) => {
      if (!s || typeof s !== 'object') throw new HttpError(400, `slots[${i}] must be an object`);
      for (const f of ['id', 'provider', 'start', 'end']) {
        if (!isNonEmptyString(s[f])) throw new HttpError(400, `slots[${i}].${f} is required`);
      }
      const start = parseIsoDate(s.start);
      const end = parseIsoDate(s.end);
      if (!start) throw new HttpError(400, `slots[${i}].start is not a valid date-time`);
      if (!end) throw new HttpError(400, `slots[${i}].end is not a valid date-time`);
      if (seen.has(s.id)) throw new HttpError(400, `duplicate slot id: ${s.id}`);
      seen.add(s.id);
      return [s.id, s.provider, s.start, s.end, start.toISOString(), end.toISOString()];
    });

    await tx(async (c) => {
      await c.query('TRUNCATE bookings, idempotency_keys, booking_attempts, slots RESTART IDENTITY');
      if (rows.length) {
        // Single multi-row insert via UNNEST.
        const cols = [[], [], [], [], [], []];
        rows.forEach((r) => r.forEach((v, j) => cols[j].push(v)));
        await c.query(
          `INSERT INTO slots (id, provider, start_raw, end_raw, start_at, end_at)
           SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[],
                                $5::timestamptz[], $6::timestamptz[])`,
          cols,
        );
      }
    });

    res.status(200).json({ status: 'ok', slots: rows.length });
  }));

  // ---- GET /slots (Level 1) -----------------------------------------------
  app.get('/slots', wrap(async (req, res) => {
    const { provider } = req.query;
    if (provider !== undefined && typeof provider !== 'string') {
      throw new HttpError(400, 'provider must be a string');
    }
    const { rows } = await pool.query(
      `SELECT s.id, s.provider, s.start_raw, s.end_raw,
              NOT EXISTS (SELECT 1 FROM bookings b
                          WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
         FROM slots s
        WHERE ($1::text IS NULL OR s.provider = $1)
        ORDER BY s.start_at, s.id`,
      [provider === undefined ? null : provider],
    );
    res.json({ slots: rows.map(toSlot) });
  }));

  // ---- POST /bookings (Levels 1–5) ----------------------------------------
  app.post('/bookings', wrap(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'body must be a JSON object');
    }
    const rawKey = req.get('Idempotency-Key');
    const idemKey = rawKey && rawKey.trim() ? rawKey.trim() : null;
    const requestHash = hashBody(body);

    const result = await tx(async (c) => {
      // Level 4: serialise requests sharing a key, then replay or reject.
      if (idemKey) {
        await c.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [LOCK_IDEMPOTENCY, idemKey]);
        const { rows } = await c.query(
          'SELECT request_hash, status_code, body FROM idempotency_keys WHERE key = $1', [idemKey],
        );
        if (rows.length) {
          if (rows[0].request_hash !== requestHash) {
            return { status: 422, body: { error: 'Idempotency-Key was already used with a different request body' } };
          }
          return { status: rows[0].status_code, body: rows[0].body, replay: true };
        }
      }

      const outcome = await attemptBooking(c, body);

      // Store the final answer so retries get exactly the same response.
      // 429 is transient and never stored.
      if (idemKey && outcome.status !== 429) {
        await c.query(
          `INSERT INTO idempotency_keys (key, request_hash, status_code, body)
           VALUES ($1, $2, $3, $4)`,
          [idemKey, requestHash, outcome.status, outcome.body],
        );
      }
      return outcome;
    });

    if (result.headers) res.set(result.headers);
    if (result.replay) res.set('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
  }));

  async function attemptBooking(c, body) {
    const email = normaliseEmail(body.email);

    // Level 5: at most N attempts per email per window, failed ones included.
    // An email containing a NUL can't be stored, so it skips straight to the 400 below.
    if (isNonEmptyString(email) && !email.includes('\0')) {
      await c.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [LOCK_RATE_EMAIL, email]);
      await c.query(
        `DELETE FROM booking_attempts
          WHERE email = $1 AND at <= clock_timestamp() - make_interval(secs => $2)`,
        [email, RATE_LIMIT_WINDOW_SEC],
      );
      const { rows } = await c.query(
        `SELECT count(*)::int AS n,
                EXTRACT(EPOCH FROM (min(at) + make_interval(secs => $2) - clock_timestamp()))::float AS wait
           FROM booking_attempts WHERE email = $1`,
        [email, RATE_LIMIT_WINDOW_SEC],
      );
      if (rows[0].n >= RATE_LIMIT_MAX) {
        const retryAfter = Math.max(1, Math.ceil(rows[0].wait));
        return {
          status: 429,
          body: { error: 'too many booking attempts for this email, try again later' },
          headers: { 'Retry-After': String(retryAfter) },
        };
      }
      await c.query('INSERT INTO booking_attempts (email) VALUES ($1)', [email]);
    }

    // Level 2: validation.
    const { slot_id: slotId } = body;
    const name = typeof body.name === 'string' ? body.name.trim() : body.name;
    if (!isNonEmptyString(slotId)) return { status: 400, body: { error: 'slot_id is required' } };
    if (!isNonEmptyString(name)) return { status: 400, body: { error: 'name is required' } };
    if (!isNonEmptyString(email)) return { status: 400, body: { error: 'email is required' } };
    if (!isValidEmail(email)) return { status: 400, body: { error: 'email is not valid' } };
    if (name.length > 200) return { status: 400, body: { error: 'name is too long' } };
    // Postgres text can't hold NUL. Reject here so the attempt above still counts.
    if (slotId.includes('\0')) return { status: 400, body: { error: 'slot_id is not valid' } };
    if (name.includes('\0')) return { status: 400, body: { error: 'name is not valid' } };

    const slot = await c.query(
      'SELECT id, start_at <= now() AS started FROM slots WHERE id = $1', [slotId],
    );
    if (!slot.rows.length) return { status: 404, body: { error: 'slot not found' } };
    if (slot.rows[0].started) return { status: 400, body: { error: 'slot has already started' } };

    // Level 3: the partial unique index makes this atomic. Under any amount of
    // concurrency exactly one insert succeeds; the rest get no row back.
    // clock_timestamp(), not now(): now() is when the transaction began, before it
    // waited for the email lock, which could put created_at out of list order.
    const inserted = await c.query(
      `INSERT INTO bookings (id, slot_id, name, email, status, created_at)
       VALUES ($1, $2, $3, $4, 'confirmed', clock_timestamp())
       ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
       RETURNING id, slot_id, name, email, status, created_at`,
      [crypto.randomUUID(), slotId, name, email],
    );
    if (!inserted.rows.length) return { status: 409, body: { error: 'slot already booked' } };
    return { status: 201, body: toBooking(inserted.rows[0]) };
  }

  // ---- GET /bookings (Level 4) --------------------------------------------
  app.get('/bookings', wrap(async (req, res) => {
    const { email, limit, cursor } = req.query;
    if (!isNonEmptyString(email)) throw new HttpError(400, 'email is required');

    let pageSize = 10;
    if (limit !== undefined) {
      if (typeof limit !== 'string' || !/^\d+$/.test(limit)) throw new HttpError(400, 'limit must be an integer from 1 to 50');
      pageSize = Number(limit);
      if (pageSize < 1 || pageSize > 50) throw new HttpError(400, 'limit must be an integer from 1 to 50');
    }

    let afterSeq = null;
    if (cursor !== undefined && cursor !== '') {
      afterSeq = typeof cursor === 'string' ? decodeCursor(cursor) : null;
      if (afterSeq === null) throw new HttpError(400, 'cursor is not valid');
    }

    const { rows } = await pool.query(
      `SELECT seq, id, slot_id, name, email, status, created_at
         FROM bookings
        WHERE email = $1 AND ($2::bigint IS NULL OR seq > $2::bigint)
        ORDER BY seq
        LIMIT $3`,
      [normaliseEmail(email), afterSeq, pageSize + 1],
    );
    const page = rows.slice(0, pageSize);
    const nextCursor = rows.length > pageSize ? encodeCursor(page[page.length - 1].seq) : null;
    res.json({ bookings: page.map(toBooking), next_cursor: nextCursor });
  }));

  // ---- GET /bookings/:id (Level 1) ----------------------------------------
  app.get('/bookings/:id', wrap(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT id, slot_id, name, email, status, created_at FROM bookings WHERE id = $1',
      [req.params.id],
    );
    if (!rows.length) throw new HttpError(404, 'booking not found');
    res.json(toBooking(rows[0]));
  }));

  // ---- DELETE /bookings/:id (Level 3) -------------------------------------
  app.delete('/bookings/:id', wrap(async (req, res) => {
    // Conditional update: two concurrent cancels can't both succeed.
    const { rows } = await pool.query(
      `UPDATE bookings SET status = 'cancelled'
        WHERE id = $1 AND status = 'confirmed'
        RETURNING id, slot_id, name, email, status, created_at`,
      [req.params.id],
    );
    if (rows.length) return res.json(toBooking(rows[0]));

    const exists = await pool.query('SELECT 1 FROM bookings WHERE id = $1', [req.params.id]);
    if (!exists.rows.length) throw new HttpError(404, 'booking not found');
    throw new HttpError(409, 'booking already cancelled');
  }));

  // ---- Fallthrough and errors ---------------------------------------------
  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      if (err.headers) res.set(err.headers);
      return res.status(err.status).json({ error: err.message });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'body too large' });
    // A path like /bookings/%ZZ that can't be decoded.
    if (err instanceof URIError) return res.status(400).json({ error: 'malformed URL' });
    // Postgres 22021: text it can't store, such as a NUL character.
    if (err.code === '22021') return res.status(400).json({ error: 'request contains invalid characters' });
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

module.exports = { createApp };
