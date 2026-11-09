// Integration tests against a real Postgres. Run with:
//   DATABASE_URL=postgres://... npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.API_KEY = 'test-key-123';
const { createApp } = require('../src/app');
const { migrate, pool } = require('../src/db');

let base;
let server;
const KEY = { 'X-API-Key': 'test-key-123' };

async function call(method, path, { body, headers = {}, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...KEY, ...headers },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, headers: res.headers };
}

const future = (h) => new Date(Date.now() + h * 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
const SLOTS = [
  { id: 's2', provider: 'Dr Bello', start: future(48), end: future(48.5) },
  { id: 's1', provider: 'Dr Ade', start: future(24), end: future(24.5) },
  { id: 's3', provider: 'Dr Ade', start: future(72), end: future(72.5) },
  { id: 'past', provider: 'Dr Ade', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' },
];
const reset = (slots = SLOTS) => call('POST', '/reset', { body: { slots } });
let n = 0;
const uniqueEmail = () => `user${Date.now()}${n++}@example.com`;

before(async () => {
  await migrate();
  server = createApp({ apiKey: process.env.API_KEY }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

// ---------------- Level 1 ----------------
test('L1: reset, list slots earliest first, provider filter', async () => {
  assert.equal((await reset()).status, 200);
  const { status, body } = await call('GET', '/slots');
  assert.equal(status, 200);
  assert.deepEqual(body.slots.map((s) => s.id), ['past', 's1', 's2', 's3']);
  assert.deepEqual(body.slots[1], { ...SLOTS[1], available: true });
  const ade = await call('GET', '/slots?provider=Dr%20Ade');
  assert.deepEqual(ade.body.slots.map((s) => s.id), ['past', 's1', 's3']);
  const none = await call('GET', '/slots?provider=dr%20ade');
  assert.equal(none.body.slots.length, 0, 'provider match is exact');
});

test('L1: book a slot and look it up', async () => {
  await reset();
  const r = await call('POST', '/bookings', { body: { slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'confirmed');
  assert.equal(r.body.slot_id, 's1');
  assert.ok(r.body.id && r.body.created_at);
  assert.deepEqual(Object.keys(r.body).sort(), ['created_at', 'email', 'id', 'name', 'slot_id', 'status']);
  const g = await call('GET', `/bookings/${r.body.id}`);
  assert.equal(g.status, 200);
  assert.deepEqual(g.body, r.body);
  const slots = await call('GET', '/slots');
  assert.equal(slots.body.slots.find((s) => s.id === 's1').available, false);
  assert.equal((await call('GET', '/bookings/nope')).status, 404);
});

test('L1: reset deletes every booking', async () => {
  await reset();
  const r = await call('POST', '/bookings', { body: { slot_id: 's1', name: 'A', email: uniqueEmail() } });
  await reset();
  assert.equal((await call('GET', `/bookings/${r.body.id}`)).status, 404);
});

// ---------------- Level 2 ----------------
test('L2: missing or wrong API key returns 401 on every endpoint', async () => {
  for (const [m, p] of [['GET', '/slots'], ['POST', '/reset'], ['POST', '/bookings'], ['GET', '/bookings?email=a@b.co'], ['GET', '/bookings/x'], ['DELETE', '/bookings/x']]) {
    const noKey = await fetch(base + p, { method: m });
    assert.equal(noKey.status, 401, `${m} ${p} without key`);
    assert.ok((await noKey.json()).error);
    const bad = await call(m, p, { headers: { 'X-API-Key': 'wrong' } });
    assert.equal(bad.status, 401, `${m} ${p} with wrong key`);
  }
});

test('L2: validation, trimming and lower-casing', async () => {
  await reset();
  const bad = [
    {}, { name: 'A', email: 'a@b.co' }, { slot_id: 's1', email: 'a@b.co' }, { slot_id: 's1', name: 'A' },
    { slot_id: '', name: 'A', email: 'a@b.co' }, { slot_id: 's1', name: '   ', email: 'a@b.co' },
    { slot_id: 's1', name: 'A', email: '  ' }, { slot_id: 's1', name: 'A', email: 'not-an-email' },
    { slot_id: 's1', name: 'A', email: 'a@b' }, { slot_id: 's1', name: 123, email: 'a@b.co' },
  ];
  for (const b of bad) {
    const r = await call('POST', '/bookings', { body: b });
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.equal(typeof r.body.error, 'string');
  }
  assert.equal((await call('POST', '/bookings', { raw: '{bad json' })).status, 400);
  assert.equal((await call('POST', '/bookings', { body: { slot_id: 'zzz', name: 'A', email: uniqueEmail() } })).status, 404);
  assert.equal((await call('POST', '/bookings', { body: { slot_id: 'past', name: 'A', email: uniqueEmail() } })).status, 400);

  const ok = await call('POST', '/bookings', { body: { slot_id: 's1', name: '  Ada Obi  ', email: '  ADA@Example.COM ' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.name, 'Ada Obi');
  assert.equal(ok.body.email, 'ada@example.com');
});

test('L2: malformed emails are rejected, ordinary ones get through', async () => {
  await reset();
  const bad = ['a@b..com', 'a@b.com.', '.a@b.com', 'a.@b.com', 'a..b@c.com', 'a@-b.com', 'a@b-.com',
    'a,b@c.com', '<a@b.com>', 'a@b.com,c@d.com', 'a@b.c', 'a@b,com'];
  for (const email of bad) {
    const r = await call('POST', '/bookings', { body: { slot_id: 's1', name: 'A', email } });
    assert.equal(r.status, 400, email);
  }
  // Valid addresses pass validation and reach the slot lookup, hence 404.
  const good = ['first.last+tag@sub.example.co.uk', "o'neil@example.com", 'a_b-c@my-clinic.org', 'x@b.co', 'x@example.xn--p1ai'];
  for (const email of good) {
    const r = await call('POST', '/bookings', { body: { slot_id: 'zzz', name: 'A', email } });
    assert.equal(r.status, 404, email);
  }
});

test('L2: undecodable URLs and NUL characters get a 400, never a 500', async () => {
  await reset();
  for (const [m, p] of [
    ['GET', '/bookings/%ZZ'], ['DELETE', '/bookings/%E0%A4%A'], ['GET', '/bookings/%00'], ['DELETE', '/bookings/%00'],
    ['GET', '/slots?provider=%00'], ['GET', '/bookings?email=a%00@b.co'],
  ]) {
    const r = await call(m, p);
    assert.equal(r.status, 400, `${m} ${p}`);
    assert.equal(typeof r.body.error, 'string');
  }
  for (const b of [
    { slot_id: 's1', name: 'a\u0000b', email: uniqueEmail() },
    { slot_id: 's\u00001', name: 'a', email: uniqueEmail() },
    { slot_id: 's1', name: 'a', email: `a\u0000${uniqueEmail()}` },
  ]) {
    assert.equal((await call('POST', '/bookings', { body: b })).status, 400, JSON.stringify(b));
  }

  // These still count as failed attempts for the rate limit.
  const email = uniqueEmail();
  const codes = [];
  for (let i = 0; i < 6; i++) {
    codes.push((await call('POST', '/bookings', { body: { slot_id: 's1', name: 'a\u0000b', email } })).status);
  }
  assert.deepEqual(codes, [400, 400, 400, 400, 400, 429]);

  // A rejected reset must leave the existing slots untouched.
  const r = await reset([{ id: 'a\u0000b', provider: 'P', start: future(1), end: future(2) }]);
  assert.equal(r.status, 400);
  assert.equal((await call('GET', '/slots')).body.slots.length, SLOTS.length);
});

// ---------------- Level 3 ----------------
test('L3: 50 simultaneous bookings of one slot → exactly one 201, rest 409', async () => {
  await reset();
  const results = await Promise.all(Array.from({ length: 50 }, () =>
    call('POST', '/bookings', { body: { slot_id: 's2', name: 'Racer', email: uniqueEmail() } })));
  const codes = results.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 201).length, 1);
  assert.equal(codes.filter((c) => c === 409).length, 49);
  const { rows } = await pool.query("SELECT count(*)::int n FROM bookings WHERE slot_id='s2' AND status='confirmed'");
  assert.equal(rows[0].n, 1);
});

test('L3: cancel frees the slot; cancelling twice is 409; unknown is 404', async () => {
  await reset();
  const b = await call('POST', '/bookings', { body: { slot_id: 's1', name: 'A', email: uniqueEmail() } });
  assert.equal((await call('POST', '/bookings', { body: { slot_id: 's1', name: 'B', email: uniqueEmail() } })).status, 409);
  const d = await call('DELETE', `/bookings/${b.body.id}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.status, 'cancelled');
  assert.equal(d.body.id, b.body.id);
  assert.equal((await call('GET', `/bookings/${b.body.id}`)).body.status, 'cancelled');
  assert.equal((await call('GET', '/slots')).body.slots.find((s) => s.id === 's1').available, true);
  assert.equal((await call('DELETE', `/bookings/${b.body.id}`)).status, 409);
  assert.equal((await call('DELETE', '/bookings/nope')).status, 404);
  assert.equal((await call('POST', '/bookings', { body: { slot_id: 's1', name: 'B', email: uniqueEmail() } })).status, 201);
});

test('L3: concurrent cancels of one booking → one 200, rest 409', async () => {
  await reset();
  const b = await call('POST', '/bookings', { body: { slot_id: 's1', name: 'A', email: uniqueEmail() } });
  const codes = (await Promise.all(Array.from({ length: 10 }, () => call('DELETE', `/bookings/${b.body.id}`)))).map((r) => r.status);
  assert.equal(codes.filter((c) => c === 200).length, 1);
  assert.equal(codes.filter((c) => c === 409).length, 9);
});

// ---------------- Level 4 ----------------
test('L4: same Idempotency-Key + same body → same response, one booking', async () => {
  await reset();
  const email = uniqueEmail();
  const body = { slot_id: 's1', name: 'Ada', email };
  const h = { 'Idempotency-Key': 'key-abc' };
  const a = await call('POST', '/bookings', { body, headers: h });
  const b = await call('POST', '/bookings', { body: { email, name: 'Ada', slot_id: 's1' }, headers: h }); // key order differs
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.deepEqual(b.body, a.body);
  const list = await call('GET', `/bookings?email=${email}`);
  assert.equal(list.body.bookings.length, 1);
});

test('L4: concurrent retries with one key create exactly one booking', async () => {
  await reset();
  const email = uniqueEmail();
  const rs = await Promise.all(Array.from({ length: 5 }, () =>
    call('POST', '/bookings', { body: { slot_id: 's3', name: 'Ada', email }, headers: { 'Idempotency-Key': 'race-key' } })));
  assert.ok(rs.every((r) => r.status === 201));
  assert.equal(new Set(rs.map((r) => r.body.id)).size, 1);
});

test('L4: same key + different body → 422; error responses replay too', async () => {
  await reset();
  const h = { 'Idempotency-Key': 'key-xyz' };
  const email = uniqueEmail();
  assert.equal((await call('POST', '/bookings', { body: { slot_id: 's1', name: 'Ada', email }, headers: h })).status, 201);
  const diff = await call('POST', '/bookings', { body: { slot_id: 's2', name: 'Ada', email }, headers: h });
  assert.equal(diff.status, 422);
  assert.ok(diff.body.error);

  const h2 = { 'Idempotency-Key': 'key-404' };
  const e2 = uniqueEmail();
  const first = await call('POST', '/bookings', { body: { slot_id: 'nope', name: 'A', email: e2 }, headers: h2 });
  const again = await call('POST', '/bookings', { body: { slot_id: 'nope', name: 'A', email: e2 }, headers: h2 });
  assert.equal(first.status, 404);
  assert.deepEqual([again.status, again.body], [first.status, first.body]);
});

test('L4: list bookings with cursor pagination, oldest first, case-insensitive email', async () => {
  const slots = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, provider: 'Dr P', start: future(10 + i), end: future(10.5 + i) }));
  await reset(slots);
  const email = uniqueEmail();
  const ids = [];
  // Spread across 2 emails variants to respect the 5/min limit while testing case-insensitivity.
  for (let i = 0; i < 5; i++) {
    ids.push((await call('POST', '/bookings', { body: { slot_id: `p${i}`, name: 'P', email: i % 2 ? email.toUpperCase() : email } })).body.id);
  }
  await call('POST', '/bookings', { body: { slot_id: 'p5', name: 'Other', email: uniqueEmail() } });

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const q = `/bookings?email=${encodeURIComponent(email.toUpperCase())}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await call('GET', q);
    assert.equal(r.status, 200);
    assert.ok('next_cursor' in r.body);
    seen.push(...r.body.bookings.map((b) => b.id));
    cursor = r.body.next_cursor;
    pages++;
  } while (cursor);
  assert.deepEqual(seen, ids);
  assert.equal(pages, 3);

  const all = await call('GET', `/bookings?email=${email}`);
  assert.equal(all.body.bookings.length, 5);
  assert.equal(all.body.next_cursor, null);
  const exact = await call('GET', `/bookings?email=${email}&limit=5`);
  assert.equal(exact.body.next_cursor, null, 'exactly-full last page has null cursor');

  for (const l of ['0', '51', '-1', 'abc', '1.5', '']) {
    assert.equal((await call('GET', `/bookings?email=${email}&limit=${l}`)).status, 400, `limit=${l}`);
  }
  assert.equal((await call('GET', '/bookings')).status, 400);
  assert.equal((await call('GET', `/bookings?email=${email}&cursor=garbage!!`)).status, 400);
  assert.equal((await call('GET', `/bookings?email=${email}&limit=50`)).status, 200);
  assert.equal((await call('GET', `/bookings?email=${email}&limit=1`)).body.bookings.length, 1);
});

test('L4: list stays oldest-first when one person books several slots at once', async () => {
  for (let round = 0; round < 5; round++) {
    await reset(Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, provider: 'Dr C', start: future(10 + i), end: future(10.5 + i) })));
    const email = uniqueEmail();
    const rs = await Promise.all([0, 1, 2, 3, 4].map((i) =>
      call('POST', '/bookings', { body: { slot_id: `c${i}`, name: 'C', email } })));
    assert.ok(rs.every((r) => r.status === 201));
    const times = (await call('GET', `/bookings?email=${email}`)).body.bookings.map((b) => b.created_at);
    assert.deepEqual(times, [...times].sort());
  }
});

// ---------------- Level 5 ----------------
test('L5: 6th attempt per email per minute → 429 with Retry-After; other emails unaffected', async () => {
  await reset();
  const email = uniqueEmail();
  const codes = [];
  for (let i = 0; i < 5; i++) {
    // Mix of failures (404) and a success: failed attempts count too.
    const slot = i === 0 ? 's1' : 'missing';
    codes.push((await call('POST', '/bookings', { body: { slot_id: slot, name: 'Spam', email } })).status);
  }
  assert.deepEqual(codes, [201, 404, 404, 404, 404]);
  const sixth = await call('POST', '/bookings', { body: { slot_id: 's2', name: 'Spam', email: email.toUpperCase() } });
  assert.equal(sixth.status, 429);
  assert.ok(sixth.body.error);
  const ra = sixth.headers.get('retry-after');
  assert.match(ra, /^\d+$/);
  assert.ok(Number(ra) >= 1 && Number(ra) <= 60, `Retry-After ${ra}`);
  const other = await call('POST', '/bookings', { body: { slot_id: 's2', name: 'Fine', email: uniqueEmail() } });
  assert.equal(other.status, 201);
});

test('L5: limit holds under a concurrent burst', async () => {
  await reset();
  const email = uniqueEmail();
  const rs = await Promise.all(Array.from({ length: 20 }, () =>
    call('POST', '/bookings', { body: { slot_id: 'missing', name: 'Burst', email } })));
  assert.equal(rs.filter((r) => r.status === 429).length, 15);
  assert.equal(rs.filter((r) => r.status === 404).length, 5);
});

test('Misc: unknown route → JSON 404; web page served without a key', async () => {
  const r = await call('GET', '/nope');
  assert.equal(r.status, 404);
  assert.ok(r.body.error);
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Clinic/);
});
