import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ConflictError } from '../../lib/errors.js';
import { syncRunsReclaimedTotal } from '../../telemetry/metrics.js';

/**
 * Claims the right to sync a user by INSERTing the `sync_runs` row and letting
 * the database arbitrate.
 *
 * A partial unique index — `(user_id) WHERE status = 'running'` — makes the
 * INSERT itself the mutual exclusion, with no check-then-act window. The index
 * is load-bearing, not decoration: `INSERT ... WHERE NOT EXISTS` reads the
 * transaction's MVCC snapshot, cannot see a concurrent uncommitted row, and so
 * admits both claimants. A unique key is enforced in the index structure
 * instead, so the loser blocks and then fails `23505`. Both halves are pinned
 * by `tests/integration/sync-claim.test.ts`.
 *
 * No lock is taken. An advisory lock would be redundant and would pin a pooled
 * connection for the whole sync; this holds one for about two milliseconds.
 *
 * Reclaim and insert share one transaction so a crashed run cannot wedge a user
 * forever, and the transaction commits before any upstream work — held open, a
 * competitor would block on the uncommitted key instead of failing fast.
 */

/**
 * A run may not exceed this. Enforced from BOTH sides, which is what makes it a
 * bound rather than a guess:
 *
 * - the run itself checks the clock at every page boundary and aborts once it
 *   is past — a Banking API sick enough to need longer than this is one we
 *   should back away from, not keep hammering;
 * - the next claim reclaims any `running` row older than the deadline plus a
 *   grace period.
 *
 * Because a live run always stops itself first, reclamation can only ever find
 * a row whose owner is genuinely gone. The grace period is what guarantees the
 * ordering: it leaves the aborting run time to write its own terminal status.
 */
export const SYNC_DEADLINE_MS = 600_000;
export const SYNC_RECLAIM_GRACE_MS = 60_000;
export const SYNC_RECLAIM_AFTER_MS = SYNC_DEADLINE_MS + SYNC_RECLAIM_GRACE_MS;

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * `lock_timeout` firing while we wait on the partial unique index. It means the
 * same thing as a unique violation — someone else holds this user's slot — we
 * just gave up waiting to find out rather than blocking. Both are a 409, not a
 * 500. In practice the claim transaction commits before any upstream work, so
 * the wait is milliseconds; this covers the pathological case.
 */
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
  /** Accounts walked to completion. The whole of coverage accounting. */
  coveredAccountIds?: readonly string[];
  error?: string;
}

export interface SyncRunHandle {
  readonly runId: string;
  /**
   * True once the run has outlived `SYNC_DEADLINE_MS`. Checked at every page
   * boundary; a run that sees `true` must stop fetching.
   */
  isPastDeadline(): boolean;
  /** Milliseconds since the claim was taken. */
  elapsedMs(): number;
  /**
   * Records the terminal status and totals. Optional: if the callback returns
   * without calling this, `withSyncRun` finalises as `succeeded`. Nothing that
   * returns or throws can leave a `running` row behind, so the reclaim timeout
   * is only ever needed for an actual process death.
   */
  finish(status: SyncRunStatus, totals?: SyncRunTotals): Promise<void>;
}

function isSlotTaken(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === UNIQUE_VIOLATION || code === LOCK_NOT_AVAILABLE;
}

/**
 * Runs `fn` as the single in-flight sync for `userId`, and always drives the
 * run row to a terminal status — `failed` if `fn` throws, so a crash inside the
 * process cannot leave a row that only the reclaim timeout can clear.
 */
export async function withSyncRun<T>(
  pool: pg.Pool,
  userId: string,
  trigger: 'api' | 'scoring' | 'scheduled' | 'webhook',
  fn: (run: SyncRunHandle) => Promise<T>,
  // A nightly batch may reasonably allow itself longer than a user waiting on
  // an HTTP response. Reclamation always uses the constant, so a run given a
  // longer budget than SYNC_DEADLINE_MS can still be reclaimed under it.
  options: { deadlineMs?: number } = {},
): Promise<T> {
  const deadlineMs = options.deadlineMs ?? SYNC_DEADLINE_MS;
  const runId = randomUUID();
  const startedAt = Date.now();
  const claimant = await pool.connect();
  try {
    await claimant.query('BEGIN');
    // Clear the residue of any process that died mid-sync. Safe to do here:
    // if two claimants race, the INSERT below still admits only one.
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
    // A process died mid-sync. The request that died never returned a status,
    // so no HTTP metric can show this — only the cleanup that follows it.
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
    // Released before any upstream work begins — nothing is pinned for the
    // duration of the sync.
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
    // No "did the callback finalise?" flag: `finishRun` only updates a row that
    // is still `running`, so this is a no-op when the callback already recorded
    // a status, and the default when it did not. Relying on that idempotency
    // beats tracking mutable state the type checker cannot follow through a
    // closure — and it is the same property `finishRun` is already tested for.
    await finishRun(pool, runId, 'succeeded');
    return result;
  } catch (err) {
    // `finishRun` only touches a `running` row, so this cannot overwrite a
    // status the callback already recorded before throwing.
    await finishRun(pool, runId, 'failed', {
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    throw err;
  }
}

/** Drives a run to a terminal status. Idempotent: only affects a `running` row. */
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
