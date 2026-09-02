import { z } from 'zod';

/**
 * Contract with the upstream Banking API.
 *
 * VERIFIED against {BANKING_API_BASE_URL}/openapi.yaml on 2026-08-29, and
 * against live responses. A copy of the spec and sample payloads are committed
 * under tests/fixtures/.
 *
 * These schemas are deliberately LENIENT on unknown fields and STRICT on the
 * fields we score with: an upstream that adds a field must not break a sync,
 * but one that changes `amount` to a string must fail loudly at the boundary
 * rather than produce a silently wrong score.
 */

/** GET /users/{userId}/accounts → { accounts: [...] } */
export const bankingAccountSchema = z.looseObject({
  id: z.string(),
  user_id: z.string(),
  // No `.catch()`: `type` decides whether a credit into this account is saving
  // or income, so silently defaulting an unrecognised value would misclassify
  // every transfer into it. An unknown type is a contract change we must see.
  type: z.enum(['checking', 'savings']),
  currency: z.string().default('EUR'),
  balance: z.number(),
  name: z.string().optional(),
});
export type BankingAccount = z.infer<typeof bankingAccountSchema>;

export const accountsResponseSchema = z.looseObject({
  accounts: z.array(bankingAccountSchema),
});

/**
 * GET /accounts/{accountId}/transactions?from=&to=&cursor=
 *
 * Note the field names: `date` (not booked_at), `merchant_category_code` (not
 * category), `merchant_name` (not merchant). Sign convention is explicit —
 * negative is a debit, positive a credit — and `type` states it redundantly,
 * which is a useful cross-check at ingest.
 */
export const bankingTransactionSchema = z.looseObject({
  id: z.string(),
  account_id: z.string(),
  amount: z.number(),
  currency: z.string().default('EUR'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().optional(),
  merchant_category_code: z.string().optional(),
  merchant_name: z.string().optional(),
  type: z.enum(['debit', 'credit']),
});
export type BankingTransaction = z.infer<typeof bankingTransactionSchema>;

/**
 * Page size is 15 and `next_cursor` is base64 of `{"offset":N}` — a positional
 * offset, not an opaque token. See docs/architecture-design.md §4.5 for why that means
 * a cursor must never be persisted across runs.
 */
export const transactionsPageSchema = z.looseObject({
  transactions: z.array(bankingTransactionSchema),
  next_cursor: z.string().nullish(),
});
export type TransactionsPage = z.infer<typeof transactionsPageSchema>;

/**
 * GET /dictionaries/merchant-categories
 *
 * `group` is the single source of truth for scoring semantics — essential,
 * high_risk, savings, income and fees all come from here rather than from any
 * hardcoded list. 17 categories at time of writing.
 */
export const CATEGORY_GROUPS = [
  'essential',
  'discretionary',
  'high_risk',
  'savings',
  'cash',
  'income',
  'fees',
] as const;

export const merchantCategorySchema = z.looseObject({
  code: z.string(),
  name: z.string(),
  group: z.enum(CATEGORY_GROUPS),
});
export type MerchantCategory = z.infer<typeof merchantCategorySchema>;
export type CategoryGroup = (typeof CATEGORY_GROUPS)[number];

export const merchantCategoriesResponseSchema = z.looseObject({
  categories: z.array(merchantCategorySchema),
});

/** Error envelope: { "error": "from and to query params required" } */
export const bankingErrorSchema = z.looseObject({ error: z.string() });
