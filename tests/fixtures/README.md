# Test fixtures

Two captured Banking API responses, kept because a test reads them:

| File                             | Read by                                                               |
| -------------------------------- | --------------------------------------------------------------------- |
| `transactions.acc_1001_sav.json` | `tests/unit/transfers.test.ts` — the real single-sided transfer shape |
| `merchant-categories.json`       | the category dictionary, for seeding a database without upstream      |

`banking-openapi.yaml` is the upstream spec the contract tests assert against.

Capture a fresh one with:

```bash
curl -sS -H "Authorization: Bearer $BANKING_API_KEY" \
  "$BANKING_API_BASE_URL/accounts/acc_1001_sav/transactions?from=2025-09-01&to=2027-06-30" \
  | jq . > tests/fixtures/transactions.acc_1001_sav.json
```

Anything not read by a test does not belong here — capture it when it is needed.
