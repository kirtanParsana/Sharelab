# ShareLab

Trusted sharing of underused campus equipment and spaces, built to the ShareLab PRD. A traditional Node.js HTTP server with a Turso (libSQL) database and a single-page frontend.

## Run locally

Needs **Node 22 or newer**.

```bash
cp .env.example .env   # optional; export variables in your shell if you prefer
npm install
npm start              # http://localhost:3000
npm test               # database-layer and end-to-end checks on a temporary local SQLite file
```

Without `TURSO_DATABASE_URL`, local `npm start` uses `./data/sharelab.db` (libSQL file mode). Tests always use a throwaway file database and never touch hosted Turso.

To develop against hosted Turso instead:

```bash
export TURSO_DATABASE_URL=libsql://your-db-name-your-org.turso.io
export TURSO_AUTH_TOKEN=your-token
npm start
```

## Deploy on Render (free Web Service)

1. Create a Turso database and copy the URL plus an auth token.
2. Push this repo to GitHub and create a Render Web Service from `render.yaml` (New > Blueprint), or create a Node web service manually.
3. Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` as **server-only** environment variables. Do not expose them to the browser.
4. Render build: `npm ci && npm test`. Start: `npm start`. Runtime: Node.js 22+.
5. Health check: `GET /healthz`. The process binds `0.0.0.0:$PORT` and shuts down on SIGTERM.

Production refuses a local `file:` database so data is not written to Render’s ephemeral filesystem. Demo seeding inserts accounts only when the users table is empty; it never wipes existing Turso data on restart. Set `SEED_DEMO=0` to start empty.

**Docker (any host):** `docker build -t sharelab . && docker run -p 3000:3000 -e TURSO_DATABASE_URL=... -e TURSO_AUTH_TOKEN=... -e DEMO_PASSWORD=yourpass sharelab`

### Environment variables (see `.env.example`)

| Variable | Purpose |
|---|---|
| `PORT`, `HOST` | Listen address (default 3000, 0.0.0.0) |
| `TURSO_DATABASE_URL` | Hosted Turso URL (`libsql://...`) in production, or `file:./data/sharelab.db` for local development |
| `TURSO_AUTH_TOKEN` | Turso auth token (required for hosted Turso; server-only) |
| `DEMO_PASSWORD` | Password for demo accounts (default `demo1234`), applied when the DB is first seeded |
| `SEED_DEMO=0` | Start empty with no demo users. Seeding never deletes existing users unless an admin runs reset |
| `TRUST_PROXY=0` | Ignore `X-Forwarded-For` when not behind a proxy |
| `RESEND_API_KEY`, `MAIL_FROM` | Real email delivery (optional) |
| `ANTHROPIC_API_KEY`, `AI_MODEL` | AI assists (optional) |

`DB_PATH` is no longer used.

## Test credentials (password `demo1234`)

| Email | Role |
|---|---|
| student@demo | Student, verified for safety and electronics |
| student2@demo | Student, verified for safety, high usage (hits quota) |
| owner@demo | Verified resource owner |
| manager@demo | Lab manager (reviews, check-in, credentials) |
| admin@demo | Administrator (owner verification, audit, email outbox, flags) |
| owner2@demo | Owner awaiting verification |

## Judge walkthrough (about 8 minutes)

1. `owner2@demo` cannot list. As `admin@demo` open Admin and verify the owner; then list a resource as `owner2@demo`.
2. As `student@demo`, type what you need in the match box (for example "print an enclosure"), open the suggestion, pick a slot, watch the live checklist, submit.
3. As `manager@demo`, approve. As the student, check in with a photo, then return as "Worn" with a photo. Report a Damage incident with evidence.
4. As `owner@demo`, open Incidents, tap Summary draft, then decide with reasoning. Open History on the booking (hash-chained) and Export CSV.
5. Fairness: as `student2@demo`, request the same slot, get waitlisted with a reason and free-slot suggestions; cancel the original and watch the promotion.
6. Credentials: as the student, request verification with an uploaded certificate. As `manager@demo`, view the document, try AI assist, verify.
7. As `admin@demo`: verify the audit chain, see usage flags, the email outbox and automation status.

## Architecture

- `db.js`: `@libsql/client` connection, helpers (`all` / `one` / `run`), write transactions, idempotent schema and migrations.
- `server.js`: Node.js HTTP server, business rules, role checks, audit chain, background jobs (reminders, overdue), uploads, email queue, AI assists. Booking and approval actions run inside one write transaction.
- `public/index.html`: single-page UI that renders server state and calls the API.

API: `POST /api/login`, `/api/logout`, `GET /api/state` (filtered by role), `/api/precheck`, `/api/verify`, `/healthz`, `POST /api/upload`, `GET /api/file/:id`, `POST /api/match`, `GET /api/ai/summary`, `/api/ai/credential`, `POST /api/act` with `a` = submit, approve, reject, wl, cancel, ci, co, noshow, inc, resolve, credreq, credok, credno, vown, newres, mailpref, readnotif, reset.

## Features beyond the core loop

- **Photos and documents:** condition photos at check-in and return, incident evidence, certificate uploads. Images are resized in the browser, then validated by type, size (700 KB) and file signature. Access is checked per file (owner, manager, admin and the booking's student only).
- **Email:** every notification is queued to an outbox. With `RESEND_API_KEY` it is sent; otherwise it is logged only. Users can opt out.
- **AI assists (optional, advisory):** smart resource matching, incident summary drafts, certificate detail extraction. Without an API key, matching uses a keyword fallback and the others return a plain summary or a manual-review notice. Eligibility, approvals, penalties and credential verification are never decided by AI.
- **Usage flags:** rule-based flags (repeated cancellations, no-shows, late returns, holding most of a resource's upcoming hours) shown to reviewers. Flags never apply penalties.
- **Also:** no-show marking, alternative slot suggestions on conflicts, CSV export of a booking record.

## Security and privacy

scrypt password hashing, random session tokens with expiry, rate limiting on login (per IP and per email) and AI calls, server-side authorisation on every action, parameterised SQL, output escaping, strict CSP and security headers, uploaded files served sandboxed with `nosniff`, users receive only their own records. Demo data is fictional. Turso credentials stay on the server.

## Known limitations

Single institution, no SSO, no QR codes, no extension requests, no payments or deposits, fair-use formula is a simple heuristic, email recipients use the demo addresses unless real emails are set.

## Disclosure

No templates or pre-existing code. Google Fonts load from a CDN. Built with AI assistance (Claude); disclose this in the submission.
