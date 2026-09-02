# Discussion topics

> **Status: draft.** The brief lists these as _not required to be implemented_ —
> they are the agenda for the discussion interview. Each section below is seeded
> with the position the current design already takes, so the conversation starts
> from something concrete. Items marked **TODO** need a decision.

---

## API design and evolution

**What is implemented: nothing.** The service exposes `/api/users/{userId}/...`
exactly as the brief specifies, and
carries no version segment, because shipping one before there is a second
version is ceremony that solves nothing and doubles the surface to test.

That is not the same as having no answer.

### Why the obvious answer is the wrong one here

URI versioning (`/api/v1`, `/api/v2`) is the default, and it has real virtues:
visible in logs, in curl, in a bug report; trivially routable; no content
negotiation.

But it versions **the shape of the response**, and the breaking change this API
will actually face is not a shape change.

The response already separates three layers with different stability
guarantees:

| Layer                             | Guarantee                                                             |
| --------------------------------- | --------------------------------------------------------------------- |
| `reliability_index`, `score_band` | Stable. The contract.                                                 |
| `metrics`, `data_quality`         | Additive only. New keys may appear; existing keys keep their meaning. |
| `drivers`                         | Human-readable, explicitly unstable. Never parse it.                  |

Adding a scoring signal is therefore additive — a new model version file plus new
`metrics` keys — and breaks nobody.

**Changing an existing signal is the hard case, and it is invisible to URI
versioning.** Re-weight income coverage and the same transactions produce 58 instead
of 64. Every field name is unchanged, every type is unchanged, the OpenAPI diff
is empty — and a lender's approval threshold now means something different. No
`/v2` path expresses that, because nothing about the _path's_ contract moved.

### Where it goes: date-pinned versions, Stripe-style

A consumer pins a version by date — `Bonify-Version: 2026-08-29` — and keeps
getting bug fixes and additive fields while the _scoring behaviour_ they
integrated against stays frozen. Versions are cheap to mint because most carry
no code: they are entries in a compatibility table, and only a behavioural
change adds a transformation.

For a credit-adjacent API this matters more than for a typical CRUD service:

- A lender who calibrated a decision threshold against one model cannot have
  that model change underneath them without notice. Pinning is the mechanism
  that lets them opt into a recalibration on their own schedule.
- Reproducibility is already a first-class property here —
  `score_snapshots` stores `model_version` with every decision precisely so a
  past score can be explained. Date-pinned versioning is the same idea pushed
  to the API boundary.
- Regulators and internal audit ask "what did the model do on this date?", not
  "what did `/v2` return?".

Uber's public API is closer to what is built today — URI-versioned, with the
real compatibility work happening inside the payload — which is a reasonable
place to start and a poor place to end.

### The trade-off, stated honestly

Date pinning is not free. It means maintaining a transformation chain and, in
effect, keeping old behaviour alive indefinitely; Stripe can afford that because
API compatibility is their product. A small team can drown in it. The mitigation
is a deprecation policy with real dates from day one, rather than discovering
three years in that nothing can ever be removed.

**Still open:** whether `model_version` belongs in the response body at all.
For: consumers can detect a shift they did not ask for. Against: it invites
informal pinning against a field with no support guarantee — which is the worst
of both worlds, since the obligation is implied rather than agreed.

## Data ownership and boundaries

- **Banking API owns** raw transactions, account metadata, and the merchant
  category dictionary. It is the system of record.
- **This service owns** the local mirror, the scoring model, and the audit
  trail. It is the system of record for _decisions_, not for _transactions_.
- **The frontend owns** presentation only. It must not re-derive a score, or the
  two will disagree at exactly the wrong moment.

Categorisation stays upstream — it is a property of the transaction, not of the
scoring model, and duplicating it here would create a second thing to keep in
sync. The mapping from category → _essential / high-risk / savings_ is scoring
policy and stays here. That boundary is the interesting one: it is why
`transactions.category` stores the upstream value verbatim and interpretation
happens at scoring time, so a model change can reinterpret history without
re-syncing.

Aggregation belongs here, and should stay materialised rather than recomputed —
see _Caching_ below.

## Data consistency and correctness

Already designed in:

- **Idempotency** — `transactions.id` _is_ the upstream id, so dedupe is
  `ON CONFLICT (id) DO NOTHING`, not a read-then-write race. Re-running a sync
  is always safe.
- **Partial syncs** — one database transaction per page, not one per user. A
  crash on page 40 keeps pages 1–39; `sync_runs.status` records `partial`.
- **Out-of-order and backdated transactions** — arrival order is irrelevant,
  because scoring queries by `booked_at` and never by ingest order. A
  transaction that arrives late simply changes the next score, and
  `score_snapshots.input_hash` makes that change visible rather than mysterious.
- **Retries** — classified in `banking/http.ts`: 5xx/429/408/transport get
  exponential backoff with full jitter; other 4xx are terminal.

**Drift detection** is the open question. Cheap version: compare local
transaction count and latest `booked_at` per account against upstream on each
sync, log a mismatch. Stronger version: a periodic reconciliation job that
re-fetches a rolling window and diffs, since a _changed_ or _deleted_ upstream
transaction is invisible to insert-only dedupe.

**Resolved: they are not immutable, and the schema no longer assumes it.**
Dedupe compares a `content_hash` of the scoring-relevant fields and writes a new
revision on change, archiving the prior row in `transaction_revisions`. See
§1 above. `sync.amendments` alarms if upstream starts mutating rows at a
rate the design did not anticipate.

## Scalability

Today's bottlenecks, in order:

1. **Sync is serial per account and synchronous to the request.** At 100k users
   this is the whole problem. It becomes a queue: `POST /sync` enqueues and
   returns `202` with a job id; workers drain it; a status endpoint reports
   progress. The current `sync_runs` table is already the job record.
2. **Scoring reads every transaction in the window.** Six months for one user
   is small, so this holds up well — until scores are wanted in bulk. Then it
   becomes a monthly per-user-per-category aggregate table, refreshed on sync,
   turning scoring into a read of ~36 rows instead of thousands.
3. **Postgres write throughput on bulk sync.** `COPY` instead of multi-row
   `INSERT`, and partitioning `transactions` by month — which also makes
   retention a partition drop instead of a `DELETE`.

The service itself is stateless, so horizontal scaling is uninteresting. The
database and the upstream rate limit are the real constraints.

## Sync strategy

- **Now:** on-demand, full history, synchronous.
- **Next:** scheduled rather than incremental. "Fetch only since last time" is
  deliberately not the direction —
  [§4.5](architecture-design.md#45-data-consistency): a buffered
  range confines amendment detection to the buffer, so a chargeback against an
  older transaction stays invisible while coverage still claims that range. At
  100k users the shape becomes two operations, not one: a cheap catch-up for
  new activity, plus a scheduled reconciliation that re-walks the window.
- **Then:** scheduled. Nightly per user, staggered by a hash of the user id so
  100k users do not all sync at 03:00.
- **Ideal:** webhooks. The upstream pushes a transaction-created event, the
  service enqueues a targeted incremental sync. Requires signature verification,
  replay protection, and — critically — a periodic full reconciliation anyway,
  because webhook delivery is best-effort and a missed event is an invisible
  gap in a credit decision.

**TODO:** whether a score should be invalidated eagerly when new transactions
land, or computed on read. Current design is compute-on-read, which is simpler
and always fresh.

## Caching and performance

What is worth caching, and what is not:

| Candidate                            | Verdict                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw transactions                     | Already cached — that _is_ the local store.                                                                                                   |
| Monthly aggregates per user/category | **Yes**, when scoring volume justifies it. Invalidate on sync for the affected months only.                                                   |
| Computed scores                      | **No, and `score_snapshots` is not a cache** — see below. As a cache it would save almost nothing: the cost is the query, not the arithmetic. |
| Merchant category dictionary         | **Yes**, in-process with a short TTL. It changes rarely and is fetched on every scoring request today.                                        |

### `score_snapshots` is an audit trail, not a cache

Worth being precise, because the two look alike and behave very differently.

A **cache** exists to make things fast. It can be dropped at any time and
correctness is unaffected. An **audit record** exists to answer "what did we
decide, when, and on what basis?" — and dropping it destroys information that
cannot be recomputed.

Recomputation cannot recover a past score, for three independent reasons:

- the **model** may have changed (`model_version`), so today's code answers a
  different question;
- the **data** may have changed — transactions get amended, backdated ones
  arrive;
- the **category dictionary** may have changed, moving a code between groups.

So "what did we tell that lender on 3 March, and why?" is unanswerable without
the stored row. For a credit-adjacent decision that question gets asked by
disputes, by internal audit, and potentially by a regulator.

**And as a cache it would barely help.** To know whether a cached score applies
you must compute `input_hash`, which means loading the window's transactions —
which is the expensive part. What you would save is running a pure function over
a few hundred rows: microseconds. The saving is real but negligible, so it is
not the reason the table exists, and treating it as a cache invites deleting or
truncating it under storage pressure — which would be a serious mistake.

The unique index on `(user_id, window_end, model_version, input_hash)` is
therefore not a cache key. It is a **de-duplication** key: it lets the same
decision, recomputed identically, occupy one row, while a genuinely different
input or a new model version records a _new_ row alongside the old rather than
overwriting it. The table is a history, not a current-value store.

## Explainability and auditability

The design commitment is that **a score must be reproducible after the model has
moved on**. Three things make that true:

1. `scoring.ts` is pure — no clock, no database, no network. Same input, same
   output, forever.
2. `score_snapshots` stores the window, the model version, the metrics, the
   per-component breakdown, and `input_hash`. Not just the final integer, which
   explains nothing.
3. `MODEL_VERSION` is bumped on every behavioural change, with the reasoning in
   `docs/scoring-model.md`.

Together those answer "why did this applicant get 48, and would they get 48
today?" — which are two different questions, and both get asked.

**TODO:** retention. Snapshots are the audit trail, but they are also personal
financial data. GDPR erasure and audit retention pull in opposite directions.

## Bias and fairness

Covered in depth in [`scoring-model.md`](scoring-model.md#bias-and-fairness).
The headline for the discussion:

Every failure mode of this model has the same shape — **missing data scoring as
bad data**. Cash income is invisible and reads as no income. An essential
category the applicant has no reason to spend in reads as six missed
category-months. A rent payment made from an account at another bank
reads as not paying rent. Each of these lands hardest on people who are
thin-file _because_ they are young, recently arrived, or previously unbanked —
precisely the population the product exists to serve.

The mitigation direction: wherever the model cannot distinguish "did not happen"
from "was not visible", it should say so in `drivers` and widen its uncertainty,
rather than quietly deduct.

Measurement, given `score_snapshots`: score distribution by cohort (account age,
transaction volume, number of connected accounts) and the rate at which each
component contributes zero. A component that returns zero far more often for
low-volume accounts is measuring data availability, not reliability.

## Incident thinking

**"Scores shifted overnight."** The triage path is already built into the
schema:

1. Query `score_snapshots` for the affected cohort. Did `model_version` change?
   → intended, check the deploy.
2. Same version, same `input_hash`, different score? → a determinism bug, which
   should be impossible given a pure model. Highest severity.
3. Different `input_hash`? → the data moved. Go to `sync_runs`.
4. `sync_runs` shows `partial` or `failed`? → an upstream problem. Note this no
   longer corrupts scores: since [§4.5](architecture-design.md#45-data-consistency)
   a partial sync makes scoring _refuse_ rather than return a number computed
   from a partial history. The symptom is a spike in `scoring.refusals`,
   not a drift in the score distribution.

**"Sync is failing."** `sync_runs.error`, plus the upstream status-code
distribution. Every error response carries `request_id`, which is the log key.

**Observability to add**, in priority order:

- **Score distribution over time**, alerting on drift in the band mix. This is
  the alarm that catches a bad model deploy _and_ a silent upstream
  categorisation change — nothing else catches the second.
- Sync success rate, duration, and pages fetched per run.
- Upstream latency, error rate, retry count, and rate-limit headroom.
- **`scoring.refusals`, by gap reason.** Arguably the single most important
  number in the service. Scores are never computed on partial data, so the
  question "are we serving bad scores?" became "are we refusing to serve good
  ones?" — which is visible, actionable, and names its own cause.
- Structured logs are already in place (pino, JSON, `request_id`, secrets
  redacted). Traces across sync → upstream → database would be the next
  addition.

**Settled.** The response never has to declare that it was computed on
incomplete data, because it never is: a caveat in a side field loses to the
number beside it, and a partial score is wrong in a predictable direction rather
than merely uncertain. Scoring refuses with `409 SYNC_REQUIRED`, no threshold —
[§4.5](architecture-design.md#45-data-consistency).
The cost is real: availability is now visibly coupled to sync health, which
turns a silent correctness problem into a loud operational one.
