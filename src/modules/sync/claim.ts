import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ConflictError } from '../../lib/errors.js';
import { syncRunsReclaimedTotal } from '../../telemetry/metrics.js';

/**
 * Claims the right to sync a user by INSERTing the `sync_runs` row and letting
 * the database arbitrate. The partial unique index on (user_id) WHERE running IS
 * the mutual exclusion: `INSERT ... WHERE NOT EXISTS` would read the MVCC
 * snapshot, miss a concurrent uncommitted row and admit both. The claim commits
 * before any upstream work, or a competitor blocks instead of failing fast.
 */

/**
 * Enforced from BOTH sides: the run aborts itself at a page boundary, and the
 * next claim reclaims any `running` row older than deadline + grace — so
 * reclamation only ever finds rows whose owner is genuinely gone.
 */
export const SYNC_DEADLINE_MS = 600_000;
export const SYNC_RECLAIM_GRACE_MS = 60_000;
export const SYNC_RECLAIM_AFTER_MS = SYNC_DEADLINE_MS + SYNC_RECLAIM_GRACE_MS;

const UNIQUE_VIOLATION = '23505';

const LOCK_NOT_AVAILABLE = '55P03';

export type SyncRunStatus = 'succeeded' | 'partial' | 'failed';

export interface SyncRunTotals {
  syncedAccounts?: number;
  newTransactions?: number;
  duplicateTransactions?: number;
  amendedTransactions?: number;
  pagesFetched?: number;
  accountsCompleted?: number;
  accountsFailed?: number;
  categoryVersion?: number;
  syncedFrom?: string;
  coversThrough?: string;
  coveredAccountIds?: readonly string[];
  error?: string;
}

export interface SyncRunHandle {
  readonly runId: string;
  isPastDeadline(): boolean;
  elapsedMs(): number;
  finish(status: SyncRunStatus, totals?: SyncRunTotals): Promise<void>;
}

function isSlotTaken(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === UNIQUE_VIOLATION || code === LOCK_NOT_AVAILABLE;
}

export async function withSyncRun<T>(
  pool: pg.Pool,
  userId: string,
  trigger: 'api' | 'scoring' | 'scheduled' | 'webhook',
  fn: (run: SyncRunHandle) => Promise<T>,
  options: { deadlineMs?: number } = {},
): Promise<T> {
  const deadlineMs = options.deadlineMs ?? SYNC_DEADLINE_MS;
  const runId = randomUUID();
  const startedAt = Date.now();
  const claimant = await pool.connect();
  try {
    await claimant.query('BEGIN');
    const reclaimed = await claimant.query(
      `UPDATE sync_runs
          SET status = 'abandoned',
              error = 'reclaimed: exceeded the deadline without finishing, owner presumed dead',
              finished_at = now()
        WHERE user_id = $1
          AND status = 'running'
          AND started_at < now() - make_interval(secs => $2)`,
      [userId, SYNC_RECLAIM_AFTER_MS / 1000],
    );
    if (reclaimed.rowCount) syncRunsReclaimedTotal.add(reclaimed.rowCount);
    await claimant.query(
      `INSERT INTO sync_runs (id, user_id, status, trigger, started_at)
       VALUES ($1, $2, 'running', $3, now())`,
      [runId, userId, trigger],
    );
    await claimant.query('COMMIT');
  } catch (err) {
    await claimant.query('ROLLBACK').catch(() => undefined);
    if (isSlotTaken(err)) {
      throw new ConflictError(
        `A sync is already in progress for ${userId}. Retry once it completes.`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    claimant.release();
  }

  const handle: SyncRunHandle = {
    runId,
    isPastDeadline: () => Date.now() - startedAt >= deadlineMs,
    elapsedMs: () => Date.now() - startedAt,
    async finish(status, totals) {
      await finishRun(pool, runId, status, totals);
    },
  };

  try {
    const result = await fn(handle);
    await finishRun(pool, runId, 'succeeded');
    return result;
  } catch (err) {
    await finishRun(pool, runId, 'failed', {
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    throw err;
  }
}

export async function finishRun(
  pool: pg.Pool,
  runId: string,
  status: SyncRunStatus,
  totals: SyncRunTotals = {},
): Promise<void> {
  await pool.query(
    `UPDATE sync_runs
        SET status = $2,
            finished_at = now(),
            synced_accounts = COALESCE($3, synced_accounts),
            new_transactions = COALESCE($4, new_transactions),
            duplicate_transactions = COALESCE($5, duplicate_transactions),
            amended_transactions = COALESCE($6, amended_transactions),
            pages_fetched = COALESCE($7, pages_fetched),
            accounts_completed = COALESCE($8, accounts_completed),
            accounts_failed = COALESCE($9, accounts_failed),
            synced_from = COALESCE($10::date, synced_from),
            covers_through = COALESCE($11::date, covers_through),
            covered_account_ids = COALESCE($12::jsonb, covered_account_ids),
            category_version = COALESCE($13, category_version),
            error = COALESCE($14, error)
      WHERE id = $1 AND status = 'running'`,
    [
      runId,
      status,
      totals.syncedAccounts ?? null,
      totals.newTransactions ?? null,
      totals.duplicateTransactions ?? null,
      totals.amendedTransactions ?? null,
      totals.pagesFetched ?? null,
      totals.accountsCompleted ?? null,
      totals.accountsFailed ?? null,
      totals.syncedFrom ?? null,
      totals.coversThrough ?? null,
      totals.coveredAccountIds ? JSON.stringify(totals.coveredAccountIds) : null,
      totals.categoryVersion ?? null,
      totals.error ?? null,
    ],
  );
}
