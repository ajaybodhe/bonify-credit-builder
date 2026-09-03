import { z } from 'zod';

/**
 * VERIFIED against the provider's openapi.yaml on 2026-08-29 and against live
 * responses; both are in tests/fixtures/. Lenient on unknown fields, strict on
 * the fields we score with.
 */

export const bankingAccountSchema = z.looseObject({
  id: z.string(),
  user_id: z.string(),
  // No `.catch()`: `type` decides saving vs income for every credit here.
  type: z.enum(['checking', 'savings']),
  currency: z.string().default('EUR'),
  balance: z.number(),
  name: z.string().optional(),
});
export type BankingAccount = z.infer<typeof bankingAccountSchema>;

export const accountsResponseSchema = z.looseObject({
  accounts: z.array(bankingAccountSchema),
});

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

/** A position, not a token: never persist it across runs (docs §4.5). */
export const transactionsPageSchema = z.looseObject({
  transactions: z.array(bankingTransactionSchema),
  next_cursor: z.string().nullish(),
});
export type TransactionsPage = z.infer<typeof transactionsPageSchema>;

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

export const bankingErrorSchema = z.looseObject({ error: z.string() });
