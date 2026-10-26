# Clinic Booking API

Node + Express + Postgres. One service serves both the JSON API and the web page (`/`).
Implements levels 1–5 of the Koya assessment spec.

## Run locally
```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/clinic
export API_KEY=choose-a-long-random-string
npm install && npm start
npm test        # spins up an embedded Postgres and runs the integration tests
```

## Deploy (Neon + Render, both free)
1. Neon: create a project, copy the connection string (`postgres://…?sslmode=require`).
2. Push this repo to GitHub (public).
3. Render: New → Web Service → the repo. Build `npm install --omit=dev`, start `npm start`.
   Env vars: `DATABASE_URL` (Neon string), `API_KEY` (your key).
4. Tables are created automatically on first start. Seed slots with `POST /reset`.

## How each level works
| Level | Approach |
|---|---|
| 1 | Plain REST handlers over Postgres. |
| 2 | Middleware checks `X-API-Key` (constant-time compare) before anything else. Validation trims name/email, lowercases email, checks format, 404 for unknown slot, 400 for a slot that already started. |
| 3 | A **partial unique index** `UNIQUE(slot_id) WHERE status='confirmed'`. The database picks exactly one winner in a race; losers get 409. Cancel is a single atomic `UPDATE … WHERE status='confirmed'`, which frees the slot. |
| 4 | `Idempotency-Key`: the whole booking runs in one transaction behind a Postgres advisory lock on the key, so concurrent retries serialize. The first result (status + body) is stored with a hash of the request body and replayed; a different body gives 422. Listing uses cursor pagination on a monotonically increasing `seq` (oldest first, `limit+1` trick for `next_cursor`). |
| 5 | Per-email attempts table. Inside the same transaction, behind an advisory lock on the email, count attempts in the last 60 s; ≥5 → 429 with `Retry-After` = seconds until the oldest attempt leaves the window. Failed attempts are counted too. Idempotent replays are not counted. |

Note: the web page gets the API key injected at page load, so anyone viewing the page can see it. That is inherent when a browser calls a key-protected API without a backend session; fine for this exercise.
