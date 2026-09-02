---
name: banking-api
description: Explore, call, and capture fixtures from the upstream Banking API. Use when integrating src/banking/, confirming request/response shapes against openapi.yaml, discovering test user ids, debugging a failing sync, or recording tests/fixtures. Covers auth, pagination, and the merchant categories dictionary.
---

# Banking API integration

The upstream Banking API is already deployed and is the only external
dependency. Everything in `src/banking/` talks to it.

## The contract (verified 2026-08-29)

`src/banking/types.ts` is confirmed against the spec. A copy lives at
`tests/fixtures/banking-openapi.yaml`.

```
GET /                                    discovery, no auth
GET /health                              no auth
GET /users/{userId}/accounts             → { accounts: [...] }
GET /accounts/{id}/transactions?from=&to=&cursor=   → { transactions, next_cursor }
GET /dictionaries/merchant-categories    → { categories: [...] }
```

**Any non-empty bearer token is accepted** — this is a mock. 404 for an unknown
user, 401 with no auth, 400 if `from`/`to` are missing.

Field names that differ from the obvious guess: transactions use **`date`** (not
`booked_at`), **`merchant_category_code`** (not `category`), **`merchant_name`**
(not `merchant`). Amount sign is the direction: negative = debit, positive =
credit, with `type: debit|credit` stating it redundantly.

Categories are `{ code, name, group }` where group is one of `essential`,
`discretionary`, `high_risk`, `savings`, `cash`, `income`, `fees` — 17 of them.
That `group` field is the source of truth for every scoring semantic; nothing
hardcodes category membership.

### Pagination — read this before touching sync

Page size 15. `next_cursor` is base64 of `{"offset":N}`, and the spec says
transactions may arrive **out of order across pages**. Both are true and both
matter:

- The order is deterministic for a fixed `(accountId, from, to)`, but a
  different `to` puts entirely different rows at the same offset.
- **Never persist a cursor across runs.** Resume by date range instead. Full
  reasoning in `docs/architecture-design.md` §4.5.
- **Every sync re-walks the whole range**, not just the tail — amendment
  detection only fires on rows actually re-read (docs/architecture-design.md §4.5). One account's full
  22-month range is 41 requests; a six-month window about 12.

### How far back to ask

`from` and `to` are required, and there is **no account-opened date** on
`Account` (`id`, `user_id`, `type`, `currency`, `balance`, `name`). So there is
nothing to discover about when an account starts. The only bound is the global
`data_range` published by `GET /`:

```bash
curl -sS "$BANKING_API_BASE_URL/" | jq .data_range
# { "from": "2025-09-01", "to": "2027-06-30" }
```

A range before any data returns `{"transactions":[],"next_cursor":null}` rather
than an error, so over-asking is safe — just wasteful. Sync therefore fetches
exactly this published range: how far back to look is discovered, never
configured, and `POST /sync` takes no range parameters.

```bash
set -a && source .env && set +a
H="Authorization: Bearer $BANKING_API_KEY"

curl -sS "$BANKING_API_BASE_URL/" | jq .                    # users + endpoints
curl -sS "$BANKING_API_BASE_URL/openapi.yaml"               # the contract

curl -sS -H "$H" "$BANKING_API_BASE_URL/users/user_1001/accounts" | jq .
curl -sS -H "$H" \
  "$BANKING_API_BASE_URL/accounts/acc_1001_chk/transactions?from=2025-09-01&to=2026-02-20" | jq .
curl -sS -H "$H" "$BANKING_API_BASE_URL/dictionaries/merchant-categories" | jq .
```

Ten users (`user_1001`…`user_1010`), 15 accounts, 2,596 transactions spanning
**2025-09-01 to 2027-06-30**. The data runs well into the future, so a scoring
window can be tested on either side of "today".

Decode a cursor to see what it is:

```bash
echo 'eyJvZmZzZXQiOjE1fQ==' | base64 -d   # → {"offset":15}
```

## Rules for the client

- **All outbound HTTP goes through `src/banking/http.ts`.** A lint rule blocks
  bare `fetch` so retries and timeouts cannot be bypassed by accident.
- **Retry only what is safe to retry.** 5xx, 429, 408 and transport errors get
  exponential backoff with full jitter. Every other 4xx is terminal — retrying
  a 401 only burns the rate limit.
- **Pagination is an async generator** (`streamTransactions`). Never accumulate
  a user's full history in an array; peak memory should be one page.
- **Validate at the boundary with the Zod schemas in `types.ts`.** Loose on
  unknown fields (upstream may add some), strict on the fields we score with.
- Never log the bearer token. `src/lib/logger.ts` redacts `authorization`
  headers; do not add a code path that stringifies the config object.

## Capturing fixtures

Tests must not hit the live API — it makes them non-deterministic and burns the
key. Capture once, commit, replay:

```bash
curl -sS -H "Authorization: Bearer $BANKING_API_KEY" \
  "$BANKING_API_BASE_URL/users/user_1001/accounts" \
  > tests/fixtures/accounts.user_1001.json
```

Grab one set per user profile the API exposes — the point is to cover the
scoring edge cases (no income, irregular income, heavy high-risk spend, savings
behaviour), not just the happy path.

`tests/helpers/fake-banking-api.ts` is the double the test suites use. It
reproduces the upstream's _hostile_ properties on purpose — shuffled page order,
offset cursors that shift when `to` changes, injectable mid-walk failure — so an
unsafe implementation fails instead of passing. Do not simplify it.

For a narrower stub, pass a fake `HttpClient` into `BankingApiClient`'s
constructor; the second argument exists for exactly that.

`tests/contract/` checks these assumptions against the live API on a schedule —
if the upstream ever gains an `updated_at` or stable ordering, that suite fails
and the sync strategy is worth revisiting.
