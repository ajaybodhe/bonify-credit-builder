import { z } from 'zod';

export const syncParamsSchema = z.object({
  userId: z.string().min(1).describe('Banking API user id, e.g. user_1001'),
});

export const syncResponseSchema = z.object({
  user_id: z.string(),
  synced_accounts: z
    .number()
    .int()
    .describe('Accounts this run attempted, after non-EUR ones are dropped'),
  new_transactions: z.number().int().describe('Transactions stored for the first time'),
  duplicate_transactions: z.number().int().describe('Transactions already held, unchanged'),
  amended_transactions: z
    .number()
    .int()
    .describe('Transactions upstream changed after we stored them'),
  synced_from: z
    .string()
    .describe('YYYY-MM-DD — start of the range this run fetched, not the oldest transaction found'),
  synced_to: z.string().describe('YYYY-MM-DD — end of the range this run fetched'),
  status: z
    .enum(['succeeded', 'partial'])
    .describe(
      '`partial` means at least one account did not finish. Scoring refuses until it does, ' +
        'so this must be read — the transaction counts alone look the same either way.',
    ),
  accounts_failed: z.number().int().describe('Accounts whose walk did not complete'),
  sync_run_id: z
    .string()
    .describe('Correlates this response with its `sync_runs` row and its logs'),
  warnings: z
    .array(z.string())
    .describe(
      'Anything degraded but not fatal: skipped rows, dormant accounts, a stale dictionary',
    ),
});

export type SyncParams = z.infer<typeof syncParamsSchema>;
export type SyncResponse = z.infer<typeof syncResponseSchema>;
