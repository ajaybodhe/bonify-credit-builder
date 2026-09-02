import { z } from 'zod';

export const syncParamsSchema = z.object({
  userId: z.string().min(1).describe('Banking API user id, e.g. user_1001'),
});

/**
 * The brief fixes the five fields below, and they keep their exact names and
 * meanings. Everything after them is additive — a consumer that ignores the
 * extra fields still sees precisely the documented shape.
 *
 * The additions exist because the brief's shape cannot express a **partial**
 * sync, and a partial sync that returns `200 { new_transactions: 168 }` is
 * indistinguishable from a complete one. That is the same failure class the
 * scoring endpoint's `data_quality` block addresses: degraded data must never
 * be silent.
 */
export const syncResponseSchema = z.object({
  user_id: z.string(),
  synced_accounts: z.number().int(),
  new_transactions: z.number().int(),
  duplicate_transactions: z.number().int(),
  /**
   * Start of the range this run fetched — NOT the oldest transaction returned,
   * and NOT a claim about when the account opened. The Banking API exposes no
   * account-opened date, so coverage is always a statement about what we
   * fetched.
   */
  synced_from: z.string().describe('YYYY-MM-DD — start of the range this run fetched'),
  /** End of the range this run fetched. */
  synced_to: z.string().describe('YYYY-MM-DD — end of the range this run fetched'),

  // ---- additive ----
  /** `partial` means at least one account did not finish. Treat with care. */
  status: z.enum(['succeeded', 'partial']),
  /** Correlates this response with its `sync_runs` row and its logs/traces. */
  sync_run_id: z.string(),
  /** Upstream transactions whose content changed since we last stored them. */
  amended_transactions: z.number().int(),
  accounts_failed: z.number().int(),
  /** Human-readable caveats. Empty on a clean run. */
  warnings: z.array(z.string()),
});

export type SyncParams = z.infer<typeof syncParamsSchema>;
export type SyncResponse = z.infer<typeof syncResponseSchema>;
