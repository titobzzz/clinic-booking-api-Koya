# Clinic Booking API

Koya Cohort 4, Task 1. A booking API for clinic appointment slots plus a web page that uses it.
All five levels are implemented and covered by integration tests against a real Postgres.

Stack: Node.js 22, Express, PostgreSQL (Neon), hosted on Render.

## How each level is met

| Level | Requirement | How |
|---|---|---|
| 1 | List slots, book, look up | `POST /reset`, `GET /slots` (earliest first, exact `provider` filter), `POST /bookings` → 201, `GET /bookings/{id}` |
| 2 | API key + validation | `X-API-Key` checked (constant-time) before anything else, including body parsing, so a bad key is always 401. `slot_id`, `name`, `email` required; `name`/`email` trimmed; email validated and stored lower-case. 404 unknown slot, 400 slot already started |
| 3 | No double booking, even at the same instant; cancel | A **partial unique index** `bookings(slot_id) WHERE status='confirmed'` plus `INSERT ... ON CONFLICT DO NOTHING`. The database decides, so it holds across any number of requests or server instances. Cancel is a conditional `UPDATE ... WHERE status='confirmed'`, so concurrent cancels give one 200, the rest 409, and the slot frees up |
| 4 | Idempotent retries; pagination | `Idempotency-Key` takes a transaction-scoped advisory lock on the key, so simultaneous retries are serialised. The final status and body are stored with a SHA-256 of the canonical body (key order and whitespace don't matter). Same key + same body replays the stored response; different body → 422. `GET /bookings` uses keyset pagination on a monotonic sequence with an opaque cursor; `limit` 1–50 strictly validated; email match ignores case |
| 5 | Stop spam | Sliding window in Postgres: max 5 attempts per email per 60 s, failed attempts included. The 6th gets 429 with `Retry-After` (whole seconds until the oldest attempt leaves the window). Per-email advisory lock keeps the count exact under a concurrent burst. Other emails are unaffected. Stored in the DB, so it survives restarts and works across instances |

Design notes:
- `start`/`end` are returned exactly as sent to `/reset`; a parsed `timestamptz` copy is used for ordering and the "already started" check.
- `POST /reset` also clears idempotency records and rate-limit counters, since the bookings they refer to are gone.
- `available` means "no confirmed booking". A past slot can show `available: true` but booking it still returns 400.
- Idempotency replays happen before the rate-limit check: a retry of a request already answered isn't a new attempt. 429s are never stored as idempotent responses because they're temporary.
- Every error, including 404 for unknown routes and malformed JSON, is `{"error": "..."}`.
- `GET /healthz` is the only route without a key; it exists for the host's health check.

## Web page

Served at `/` by the same service. Enter the API key once (kept in the browser's local storage), pick an upcoming time, enter name and email, and you get a confirmation with the booking ID. You can find bookings by email (paged, using `GET /bookings`) or by booking ID, and cancel them. Each booking attempt sends its own `Idempotency-Key`, and a retry after a network failure reuses it, so a double-click or lost response can't create a duplicate.

Past slots are hidden on the page, though `GET /slots` still returns them as the spec requires.

## Run locally

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL and API_KEY
export $(cat .env | xargs) && npm start
```

Tests (need a Postgres; they wipe the tables):

```bash
DATABASE_URL=postgres://... npm test
```

## Deploy (Neon + Render, both free)

### 1. Create the database on Neon
1. Go to neon.tech and sign up (GitHub sign-in is quickest).
2. Click **Create project**. Name it `clinic-booking`, pick the region closest to your Render region (e.g. AWS Frankfurt if Render is Frankfurt), Postgres 16 or 17. Click **Create**.
3. On the project dashboard you'll see **Connection string**. Make sure the **Pooled connection** toggle is OFF (the app uses advisory locks, which need a direct connection). Copy the string. It looks like
   `postgresql://neondb_owner:xxxx@ep-something.eu-central-1.aws.neon.tech/neondb?sslmode=require`
4. That's all: the app creates its tables on first start.

### 2. Push the code to GitHub
1. Create a new empty repository on GitHub (e.g. `clinic-booking-api`), public or private.
2. In this folder:
   ```bash
   git init && git add . && git commit -m "Clinic booking API"
   git branch -M main
   git remote add origin https://github.com/<you>/clinic-booking-api.git
   git push -u origin main
   ```

### 3. Create the service on Render
1. Go to render.com and sign in with GitHub.
2. Click **New +** → **Web Service** → pick your repository.
3. Settings:
   - Runtime: **Node**
   - Build command: `npm ci`
   - Start command: `npm start`
   - Instance type: **Free**
4. Under **Environment Variables** add:
   - `DATABASE_URL` = the Neon string from step 1
   - `API_KEY` = a long random string. Generate one with `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
   - `NODE_VERSION` = `22`
5. Under **Advanced**, set **Health Check Path** to `/healthz`.
6. Click **Create Web Service**. The first deploy takes 2–4 minutes. When the log shows `clinic-booking-api listening on :10000` it's live at `https://<name>.onrender.com`.

(Alternatively: **New +** → **Blueprint** and point it at the repo; `render.yaml` sets all of the above and asks you for the two secrets.)

### 4. Keep it awake
Render's free tier sleeps after 15 minutes idle and the first request then takes ~50 s, which can make the grader's checks time out. Set up a free monitor at uptimerobot.com: **Add New Monitor** → type **HTTP(s)** → URL `https://<name>.onrender.com/healthz` → interval **5 minutes**.

### 5. Smoke test the live URL
```bash
URL=https://<name>.onrender.com; KEY=<your key>
curl -s -X POST $URL/reset -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"slots":[{"id":"s1","provider":"Dr Ade","start":"2026-12-10T09:00:00Z","end":"2026-12-10T09:30:00Z"}]}'
curl -s $URL/slots -H "X-API-Key: $KEY"
curl -s -X POST $URL/bookings -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"slot_id":"s1","name":"Ada Obi","email":"ada@example.com"}'
```
Then open `https://<name>.onrender.com/` in a browser.

After submitting, don't push changes or touch the env vars until Koya gets back to you.
