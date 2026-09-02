# CLAUDE.md

Guidance for Claude Code in this repository.

## What this is

A single Node.js/TypeScript service that syncs bank transactions from an
external Banking API into Postgres, then computes an explainable Reliability
Index (0–100) from that local data. Two endpoints, nothing more.

**Do not add microservices, a UI, ML, or multi-currency support** — all
explicitly out of scope.

`docs/architecture-design.md` is the design of record. Code follows it, not the
other way round.

## Commands

```bash
npm run dev                # watch-mode server on :3000
npm run check              # typecheck + lint + format + unit — run before claiming done
npm test                   # unit only, ~200ms
npm run test:integration   # one real boundary (Postgres)
npm run test:e2e           # whole app + Postgres + fake Banking API
npm run test:contract      # hits the LIVE Banking API; opt-in, needs network
npm run docker:up          # Postgres on localhost:5433
npm run db:generate        # migration from src/db/schema.ts
npm run db:migrate         # apply committed migrations
```

## Layering

**`routes` know HTTP, `service` knows the workflow, `scoring.ts` knows the
model, and only `db/` knows SQL.**

## Rules that prevent bugs

- **ESM: `.js` extensions in relative imports**, even though the file is `.ts`.
- **`scoring.ts` and `transfers.ts` stay pure.** No database, clock, or network.
  If the model needs data, the service fetches it and passes it in — that is what
  makes a score reproducible from a stored snapshot.
- **Every tunable is a named constant in `MODEL`**, never inline in a formula.
- **Never edit a released model file.** `models/vN.ts` is immutable once frozen;
  any change — constant or logic — is a new `vN+1.ts`, registered in
  `models/index.ts`. A test hashes frozen versions and fails on edits.
- **Never overwrite a category dictionary version.** A refresh that changes
  content mints a new `merchant_category_versions` row; old versions and their
  entries stay forever. Snapshots store `model_version` and `category_version`,
  never copies.
- **Money is `numeric(14,2)` and a string in transit** — never a JS float.
- **Dates are plain `YYYY-MM-DD` in UTC.** A booking date has no timezone.
- **All outbound HTTP goes through `src/banking/http.ts`.** A lint rule blocks
  bare `fetch`.
- **Never persist a Banking API pagination cursor.** It is a base64 offset into
  an unordered result set, invalid the moment `to` changes. Resume by date range.
- **Every sync refreshes the whole requested range.** No incremental mode, no
  lateness buffer: amendments are only detected on rows re-read.
- **Scoring never triggers a sync**, and refuses on incomplete coverage with
  `409 SYNC_REQUIRED` — no threshold, not even 99%.
- **Scoring queries filter `transactions.status = 'active'`.** The `amended` and
  `reversed` states exist and are honoured, but nothing writes them yet — this
  provider exposes no reversal signal.
- **Coverage describes what we FETCHED, never what exists.** The API exposes no
  account-opened date.
- **The sync claim transaction must stay SHORT** — commit before upstream work,
  or competing claimants block instead of failing fast with `409`.
- **Telemetry is preloaded with `node --import`**, never imported from app code:
  under ESM, imports evaluate before module statements.
- **Errors are `AppError` subclasses** with a stable `code`. Wire shape is
  `{ error: { code, message, details?, request_id } }`.

## Working agreements

- Run `npm run check` before reporting work as done.
- Put a test in the cheapest tier that can prove it: unit = no I/O; integration =
  one real boundary; e2e = properties spanning layers; contract = assumptions
  about the live upstream. Reconstruction mechanics are integration; that a
  served score stays re-derivable is e2e.
- `tests/helpers/fake-banking-api.ts` deliberately reproduces the upstream's
  hostile pagination. Do not "fix" it into tidy ordering.
- Fill in the `it.todo` cases rather than inventing a parallel set.
- When implementing a stub, delete both the `TODO(...)` and the
  `throw new Error('Not implemented: ...')`.
- Keep `MODEL` constants and `docs/scoring-model.md` in sync in the same commit.
- Keep the README's AI-usage section accurate as work proceeds.

## Things that will bite you

- **TypeScript is pinned to `~6.0.3`.** `typescript-eslint` peers `<6.1.0`;
  upgrading silently disables type-aware linting.
- **`exactOptionalPropertyTypes` is on.** `{ details: undefined }` is not
  assignable to `{ details?: X }` — spread conditionally.
- **Postgres is on port 5433.** On macOS 12 Docker Desktop will not install, so
  local Postgres is Postgres.app on that port; `docker:up` and `db:reset` do not
  apply there.
- **Node 22 is the baseline** (`.nvmrc`) — Node 24 needs macOS 13.5+. CI runs both.
- Banking API field names are **verified**: transactions use `date`,
  `merchant_category_code`, `merchant_name`. Category `group` drives every
  scoring semantic. Spec copy at `tests/fixtures/banking-openapi.yaml`.
