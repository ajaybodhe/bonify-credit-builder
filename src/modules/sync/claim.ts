import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ConflictError } from '../../lib/errors.js';
import { syncRunsReclaimedTotal } from '../../telemetry/metrics.js';

/**
 * Only one sync per user at a time, and the database decides — not us.
 *
 * The claim is an INSERT, and a partial unique index (one `running` row per
 * user) rejects the second one. Checking first would not work: `INSERT ...
 * WHERE NOT EXISTS` reads its own snapshot, cannot see a competitor that has
 * not committed yet, and lets both through. The claim commits before any
 * upstream call, so the loser fails fast rather than waiting on a long
 * transaction.
 */

/**
 * How long a sync may run, enforced twice over: the run stops itself at a page
 * boundary once it is past, and the next claim takes over any `running` row
 * older than the deadline plus the grace period. Because a live run always
 * stops first, a takeover only ever finds a run whose process is gone.
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
            synced_from = COALESCE($8::date, synced_from),
            covers_through = COALESCE($9::date, covers_through),
            covered_account_ids = COALESCE($10::jsonb, covered_account_ids),
            category_version = COALESCE($11, category_version),
            error = COALESCE($12, error)
      WHERE id = $1 AND status = 'running'`,
    [
      runId,
      status,
      totals.syncedAccounts ?? null,
      totals.newTransactions ?? null,
      totals.duplicateTransactions ?? null,
      totals.amendedTransactions ?? null,
      totals.pagesFetched ?? null,
      totals.syncedFrom ?? null,
      totals.coversThrough ?? null,
      totals.coveredAccountIds ? JSON.stringify(totals.coveredAccountIds) : null,
      totals.categoryVersion ?? null,
      totals.error ?? null,
    ],
  );
}
