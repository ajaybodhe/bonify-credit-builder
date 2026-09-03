# Thin-File Credit Builder

A Node.js/TypeScript service that computes an explainable **Reliability Index
(0–100)** for thin-file users — people with no credit history, who a
conventional scorecard has nothing to say about — from six months of their bank
transactions.

It does two things: syncs a user's accounts and transactions from an external
Banking API into Postgres, then scores a six-calendar-month window from that
local data, returning the index, a band, the component metrics, and a
plain-language explanation of the result.

Built for the bonify backend challenge.

> **Status: both endpoints implemented and working.** Verified end to end against
> the live Banking API — a sync ingests 631 transactions across two accounts, and
> scoring returns an explained 0–100 index computed from local data only.

---

## Setup and run

```bash
cp .env.example .env          # then set BANKING_API_KEY
./scripts/setup.sh --start    # http://localhost:3000
```

One command, any machine: it uses Docker when Docker is available, and otherwise
falls back to a native Postgres on the same port with the service running
locally. Idempotent, and it will not install system software behind your back —
where a tool is missing it prints the command and stops.

With Docker, that is equivalent to:

```bash
docker compose up --build
```

Either way you get Postgres, the migrations applied, and the service running —
the app waits for the schema before it accepts a request. Interactive API docs,
generated from the same schemas that validate at runtime:
**<http://localhost:3000/docs>**

<details>
<summary>The native path by hand</summary>

Needs **Node ≥ 22.22** (or ≥ 24.15) and **PostgreSQL 17 on `localhost:5433`** —
5433 deliberately, so it stays clear of a system Postgres on 5432. Nothing is
installed globally: TypeScript, Vitest, ESLint and Drizzle are devDependencies.

```bash
nvm use                       # Node version from .nvmrc
npm ci
npm run db:migrate
npm run dev                   # http://localhost:3000
```

Docker Desktop does not install on macOS 12 or older; `brew install colima` is
the usual substitute there. For a native server,
[Postgres.app](https://postgresapp.com) works on macOS 10.15+ — put it on port
5433 and `DATABASE_URL` needs no change:

```bash
BIN=/Applications/Postgres.app/Contents/Versions/17/bin
DATA="$HOME/Library/Application Support/Postgres/var-17"

"$BIN/initdb" -D "$DATA" -U credit --encoding=UTF8 --locale=C \
  --auth-local=trust --auth-host=trust
echo "port = 5433" >> "$DATA/postgresql.conf"
"$BIN/pg_ctl" -D "$DATA" -l "$DATA/server.log" -w start
"$BIN/createdb" -h localhost -p 5433 -U credit credit_builder
```

</details>

### Calling the endpoints

**Sync** — re-reads the user's account list and every account's full transaction
range from the Banking API, and stores them. Nothing is incremental: both
are fetched in full every time. Takes no parameters: how far back to fetch is
discovered from the provider, not configured. Safe to re-run:
dedupe is a primary-key conflict on the upstream id resolved by content hash, so
a repeat reports duplicates and detects any upstream amendment. At most one sync
runs per user at a time.

```bash
curl -sS -X POST localhost:3000/api/users/user_1001/sync | jq .
```

```json
{
  "user_id": "user_1001",
  "synced_accounts": 2,
  "new_transactions": 631,
  "duplicate_transactions": 0,
  "amended_transactions": 0,
  "synced_from": "2025-09-01",
  "synced_to": "2027-06-30",
  "status": "succeeded",
  "sync_run_id": "…",
  "accounts_failed": 0,
  "warnings": []
}
```

`synced_to` is the end of the provider's published `data_range`, not a window —
a sync always fetches everything on offer.

**Reliability index** — scores the six calendar months ending at `from`,
inclusive, from locally stored data only.

```bash
curl -sS "localhost:3000/api/users/user_1001/reliability?from=2026-02-20" | jq .
```

```json
{
  "user_id": "user_1001",
  "from": "2026-02-20",
  "currency": "EUR",
  "reliability_index": 62,
  "score_band": "MEDIUM",
  "metrics": {
    "income_regularity": 0.83,
    "income_coverage_ratio": 1.34,
    "essential_payments_consistency": 0.89,
    "good_months": 4,
    "negative_balance_days": 63,
    "late_fee_events": 1
  },
  "drivers": ["Income present in 5/6 months", "Income covers essential expenses (1.34x)"],
  "data_quality": { "completeness": "complete", "…": "…" },
  "model_version": 1
}
```

A score is served only when synced data completely covers the requested window.
Otherwise the request is refused, naming the gap so it can be fixed:

```bash
curl -sS "localhost:3000/api/users/user_1001/reliability?from=2027-01-01" | jq .
# 409 { "error": { "code": "SYNC_REQUIRED", "details": { "gaps": [...] } } }
```

**Operational**

```bash
curl -sS localhost:3000/health   # liveness
curl -sS localhost:3000/ready    # readiness — 503 if Postgres is unreachable
curl -sS localhost:3000/openapi.yaml
```

Every error shares one shape and always carries a `request_id`:

```json
{ "error": { "code": "SYNC_REQUIRED", "message": "…", "request_id": "req-7" } }
```

### Development

```bash
npm run check              # typecheck + lint + format + unit tests
npm test                   # unit only, ~200ms
npm run test:integration   # needs Postgres
npm run test:e2e           # whole app + Postgres + fake Banking API
npm run test:contract      # hits the live Banking API; opt-in
npm run build              # → dist/
```

---

## High-level design

**[`docs/architecture-design.md`](docs/architecture-design.md)** — motivation,
goals and non-goals, success metrics, API design, data model, consistency and
concurrency guarantees, failure modes, observability, request-flow diagrams,
testing strategy, technology choices, and open questions.

## Scoring limitations and bias

**[`docs/scoring-model.md`](docs/scoring-model.md)** — every constant with its
reasoning, worked examples, and an honest account of what the model cannot see.

## Known limitations

Stated plainly, so none of it has to be discovered.

### Not verified on this machine

**The Docker image has never been built here.** Development was on macOS 12.4
(Intel), and current Docker Desktop requires macOS 13 or later; OrbStack has the
same floor. No container runtime is installed — not Docker, Colima, Podman or
Lima.

What was done instead:

- **Postgres runs natively** via Postgres.app on port 5433 — the same version
  (17) and port the compose file and CI use, so every database behaviour in this
  repo is exercised against a real Postgres, including the concurrency and
  isolation tests.
- **CI builds the image** (`docker build`, then a check that the runtime stage
  can load the migrator) on `ubuntu-latest`, which does have Docker. That job
  will pass or fail on the first push; it has never run.

So the container path is **written and reviewed, not executed here**. CI is what
verifies it. `npm run db:reset` is also Docker-based and does not run on this
machine.

**Contract tests are skipped by default** — 10 of them. They hit the live
Banking API, so they are opt-in (`npm run test:contract`) and excluded from the
PR gate: a red build caused by someone else's outage teaches people to ignore red
builds.

### Deliberately out of scope

- **No authentication or authorization.** Either endpoint will serve any
  `userId` to any caller. This is the largest gap for a credit-adjacent service
  and would be the first thing to add.
- **No deployment topology** — no orchestrator manifests, no IaC, no
  environments. The image is built by CI and published nowhere.
- **Observability is instrumented but not operationalised.** 20 metrics, traces
  and structured logs all work, but no collector configuration ships, so with no
  exporter endpoint set the SDK never starts. No dashboards, no alerting.
- **A closed account is inferred, not signalled.** Upstream publishes no
  deletion signal, so an account missing from a successful listing is marked
  dormant and dropped from the coverage gate. If upstream ever omits an account
  by mistake, we would read that as a closure until it reappears.
- **Reversals and deletions are not implemented.** A change to a transaction is
  handled: the old row is archived and replaced by the new one. Reversals and
  deletions are not, because the provider exposes no way to recognise them — no
  reversal flag, no link back to an original, no deletion signal.

### Known inaccuracies in the model

- **`negative_balance_days` is an estimate, not an observation.** The provider
  reports one undated balance that does not reconcile with the transactions it
  publishes, so the daily series is reconstructed backwards from it. For
  `user_1001` this yields 63 days where the published example shows 54; the
  reasoning is in [docs/scoring-model.md](docs/scoring-model.md).
- **The weights are a reasoned starting point, not calibrated.** Nothing here is
  fitted against repayment outcomes, so the score should inform a human decision
  rather than make one.

## Discussion topics

**[`docs/discussion-topics.md`](docs/discussion-topics.md)** — positions on API
evolution, data ownership, consistency, scalability, sync strategy, caching,
auditability, fairness, and incident response.

---

## AI usage disclosure

1. **Claude Code (Opus 5)** was used throughout the SDLC.
2. Brainstormed the plan, design and execution for both the sync and scoring phases using planning mode, deciding shape of API, project scaffolding, testing strategy, DB schema and concurrency conditions.
3. Then pushed it to generate technical documentation first, to review and validate all use cases, edge cases and correctness.
4. Asked it to verify every assumption — the Banking API contract, Postgres locking, transactions and MVCC, Fastify idiom — and to ground each one in tests across the four tiers.
5. The code was then generated for each endpoint separately and reviewed by an independent reviewer agent first on correctness, performance, security, SOLID, DRY, race conditions, stale code, unnecessary avoidable changes including repeating test cases, node.js and typescript idiomacy,
   clean code practice, cleaner separation of concerns; followed by a line-by-line human review to make sure AI slop did not slip through
6. **Human review changed the design repeatedly.** The table below is the
   record of that: the left column is something I questioned or refused to
   accept while reviewing the model's work, the right is what digging into it
   actually revealed. Several were cases where the work had already been
   reported as finished and verified. Each outcome is traceable to code or a
   test, and the reasoning survives in
   [`docs/architecture-design.md`](docs/architecture-design.md).

| What I pushed back on during review                                                          | What the investigation found, and what changed as a result                                                                                                                         |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resuming an interrupted sync from the pagination cursor the previous run stopped at          | The cursor is a positional offset, so it points at different rows once `to` moves. Proven against the live API; resume is now by date range, and the hazard has its own test.      |
| A Postgres advisory lock to stop two syncs running for the same user                         | It pins a connection for the entire sync. Replaced with a partial unique index, which fails the loser in ~1 ms. A test shows both claimants insert without it.                     |
| Scoring anyway once 67% of the window was covered                                            | Unfetched months are indistinguishable from months with no activity, so any threshold below 100% charges the applicant for our gap. Now refuses outright.                          |
| `from` and `to` query parameters on the sync endpoint, which the requirement never asked for | Removed. The range is discovered from the provider's published `data_range`, so how far back to look is neither configured nor caller-chosen.                                      |
| Score snapshots storing a copy of the model's constants so old scores stayed re-derivable    | Replaced by `models/vN.ts`, immutable once frozen and guarded by a digest test — a snapshot now needs only a version number to stay explainable.                                   |
| The merchant-category dictionary resolved at scoring time, falling back to the Banking API   | Scoring now reads the version the covering sync recorded. That removed the last outbound call from the scoring path — and exposed that `finishRun` never persisted the new column. |
| Account details, reported as already refreshed on every sync                                 | They were re-fetched, but the upsert wrote back only some fields. A stale account `type` would have misclassified every transfer into that account.                                |
| A `heartbeat_at` column, rewritten once per page, to tell a dead sync from a slow one        | Simpler without it: the run enforces a 10-minute deadline on itself and aborts. That is what makes reclamation a bound rather than a guess. Column dropped.                        |
| Timeouts and retries on every outbound HTTP call, but nothing equivalent on the database     | Postgres had none. Added statement, lock and idle-in-transaction timeouts; migrations needed an exemption, and a lock-timeout loss had to map to `409`, not `500`.                 |
| `negative_balance_days` returning 0 for a user the data showed overdrawn for months          | Two stacked bugs: an anchor that rolled back future-dated transactions into the past, and a guard that laundered the resulting nonsense into a clean `0`. Score 72 → 62.           |
| Snapshots storing only pointers — model version, category version, transaction hash          | The balance the score walked back from could not be pointed at, and `input_hash` ignored it. A restated balance would serve a new score while the snapshot kept the old one.       |
| The documented limitation "rent paid from an account the Banking API does not expose"        | The API hides nothing — it returns every account held with that provider. The real gap is an account at a _different bank_, which is a different problem with a different fix.     |
