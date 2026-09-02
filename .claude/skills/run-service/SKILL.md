---
name: run-service
description: Start the service locally and exercise both endpoints end to end. Use when asked to run, start, boot, or smoke-test the app, when verifying a change against the real service rather than tests, or when debugging startup, database connection, or migration failures.
---

# Running the service locally

## First run

```bash
cp .env.example .env       # then set BANKING_API_KEY
npm ci
npm run docker:up          # Postgres on localhost:5433
npm run db:migrate
npm run dev                # http://localhost:3000
```

Interactive API docs, generated from the same Zod schemas that validate at
runtime: <http://localhost:3000/docs>

## Smoke test

```bash
curl -sS localhost:3000/health | jq .
curl -sS localhost:3000/ready  | jq .          # 503 means Postgres is unreachable

curl -sS -X POST localhost:3000/api/users/user_1001/sync | jq .
curl -sS "localhost:3000/api/users/user_1001/reliability?from=2026-02-20" | jq .
```

On the scaffold both endpoints return `500 INTERNAL_ERROR` — the handlers
throw `Not implemented`. The service booting, `/ready` returning 200, and
`/docs` listing four routes is what "working" means right now.

Scoring refuses before it reaches the stub if the window is not covered, so a
`409 SYNC_REQUIRED` naming the gap is the expected response for an unsynced
user — that path is implemented.

## When it will not start

| Symptom                                             | Cause                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `Invalid environment configuration:` + a field list | `.env` missing or incomplete. The list names the exact fields.                                 |
| `ECONNREFUSED ... :5433`                            | Postgres is not up. `npm run docker:up`, or Postgres.app — see below.                          |
| `409 SYNC_REQUIRED` from `/reliability`             | Expected. The window is not fully covered by a sync; the response names the gap.               |
| `relation "transactions" does not exist`            | Migrations not applied. `npm run db:migrate`.                                                  |
| `EADDRINUSE :3000`                                  | Another instance is live. `lsof -ti:3000 \| xargs kill`, or set `PORT`.                        |
| `Unsupported engine` on install                     | Node too old. This repo needs Node 22.22+ or 24.15+; `nvm use` reads `.nvmrc`.                 |
| `ERR_MODULE_NOT_FOUND` for a local file             | A relative import is missing its `.js` extension. Required under `moduleResolution: nodenext`. |

## Postgres without Docker

Docker Desktop does not install on macOS 12 or older, so local Postgres may be
[Postgres.app](https://postgresapp.com) rather than a container. Same port,
same `DATABASE_URL`, so nothing else changes:

```bash
BIN=/Applications/Postgres.app/Contents/Versions/17/bin
DATA="$HOME/Library/Application Support/Postgres/var-17"

"$BIN/pg_ctl" -D "$DATA" -l "$DATA/server.log" -w start   # start
"$BIN/pg_ctl" -D "$DATA" status                            # is it up?
"$BIN/pg_ctl" -D "$DATA" stop                              # stop
"$BIN/psql" -h localhost -p 5433 -U credit -d credit_builder
```

`npm run db:reset` assumes Docker. The equivalent here is `dropdb`/`createdb`
followed by `npm run db:migrate`.

## Resetting local state

```bash
npm run db:reset      # drops the volume, recreates, re-migrates
```

Destructive — it deletes every synced transaction. Fine locally; re-sync
afterwards.

## Verifying a change

```bash
npm run check         # typecheck + lint + format:check + unit tests
```

Four test tiers, cheapest first. Only the last touches the network:

```bash
npm test                   # unit — no I/O, ~200ms
npm run test:integration   # one real boundary (Postgres)
npm run test:e2e           # whole app + Postgres + fake Banking API
npm run test:all           # everything hermetic
npm run test:contract      # hits the LIVE Banking API; opt-in
```

The Banking API double is `tests/helpers/fake-banking-api.ts`, backed by
captured responses in `tests/fixtures/`. It deliberately reproduces the
upstream's hostile pagination — shuffled order, offset cursors that shift when
`to` changes — so do not "fix" it into tidy ordering.
