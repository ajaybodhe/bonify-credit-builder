import { z } from 'zod';

export const syncParamsSchema = z.object({
  userId: z.string().min(1).describe('Banking API user id, e.g. user_1001'),
});

/**
 * The brief’s five fields keep their exact names; everything after is additive.
 * The additions exist because the brief cannot express a PARTIAL sync, and one
 * returning `200 { new_transactions: 168 }` looks identical to a complete one.
 */
export const syncResponseSchema = z.object({
  user_id: z.string(),
  synced_accounts: z.number().int(),
  new_transactions: z.number().int(),
  duplicate_transactions: z.number().int(),
  /** What we FETCHED. There is no account-opened date upstream to ask for. */
  synced_from: z.string().describe('YYYY-MM-DD — start of the range this run fetched'),
  synced_to: z.string().describe('YYYY-MM-DD — end of the range this run fetched'),

  status: z.enum(['succeeded', 'partial']),
  sync_run_id: z.string(),
  amended_transactions: z.number().int(),
  accounts_failed: z.number().int(),
  warnings: z.array(z.string()),
});

export type SyncParams = z.infer<typeof syncParamsSchema>;
export type SyncResponse = z.infer<typeof syncResponseSchema>;
