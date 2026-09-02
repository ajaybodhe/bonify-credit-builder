import type pg from 'pg';
import type { BankingApiClient } from '../../banking/client.js';
import type { Database } from '../../db/client.js';
import { ConflictError } from '../../lib/errors.js';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import type { BankingTransaction } from '../../banking/types.js';
import type { CategoryResolver } from '../reliability/categories.js';
import { SYNC_DEADLINE_MS, withSyncRun } from './claim.js';
import type { Logger } from '../../lib/logger.js';

/** Postgres unique violation: a concurrent run already minted this version. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

/** Coarse buckets — never the message, which can carry account identifiers. */
function classifyFailure(err: unknown): string {
  const status = (err as { details?: { status?: unknown } } | null)?.details?.status;
  if (typeof status === 'number') return `http_${String(Math.floor(status / 100))}xx`;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code.toLowerCase() : 'unknown';
}
import {
  categoryRefreshFailures,
  syncAccountFailures,
  syncConflictsTotal,
  syncDuration,
  syncRunsTotal,
  syncTransactionsTotal,
  transactionAmendmentsTotal,
} from '../../telemetry/metrics.js';
import type { SyncResponse } from './schemas.js';

/**
 * Pulls accounts and transactions for one user into the local store.
 *
 * The reasoning lives in docs/architecture-design.md §4.4–4.6; the invariants
 * this class must uphold are:
 *
 * 1. **Idempotent without assuming immutability.** Dedupe is a PK conflict
 *    resolved by comparing `content_hash`, not `DO NOTHING` — banks amend
 *    routinely, and ignoring a conflict leaves the mirror invisibly wrong.
 * 2. **Re-read accounts AND transactions in full every run.** The account list
 *    comes from the API, never the mirror, and every mutable field is written
 *    back — a stale `type` misclassifies transfers. Amendments are only
 *    detectable on rows actually re-read, so there is no incremental mode.
 * 3. **Commit per page, never per user.** A crash on page 40 keeps pages 1-39.
 * 4. **Only accounts walked to completion go in `covered_account_ids`.** Pages
 *    are shuffled with respect to date, so a partial walk proves nothing — and
 *    that list is the whole of coverage accounting.
 * 5. **Record the run whatever happens**, so "was Tuesday's score computed on
 *    good data?" stays answerable. Terminal status is reached exactly once.
 * 6. **Refresh the category dictionary here**, not on the scoring path.
 * 7. **Peak memory is one page**, regardless of history length.
 */
export class SyncService {
  constructor(
    private readonly db: Database,
    private readonly banking: BankingApiClient,
    private readonly pool: pg.Pool,
    private readonly categories: CategoryResolver,
    /**
     * Structured logger. Without one a per-account failure is a number in a
     * response body and nothing else — an account failing every night looks
     * identical to a healthy sync with one fewer account.
     */
    private readonly log: Logger,
    /** Overridable so a scheduled sync can allow itself a longer budget. */
    private readonly deadlineMs: number = SYNC_DEADLINE_MS,
  ) {}

  /**
   * Concurrent calls for the same user do not queue — the second gets an
   * immediate 409. Different users sync concurrently; the lock is per user.
   */
  /**
   * The range is not a parameter. A sync covers the whole span the Banking API
   * publishes in its `data_range`, because there is no account-opened date to
   * ask for and no principled smaller bound: anything narrower would leave
   * windows unscoreable with no way to ask for them.
   */
  async syncUser(userId: string): Promise<SyncResponse> {
    const startedAt = Date.now();
    try {
      // `withSyncRun` reclaims any crashed run, INSERTs this one, and commits —
      // all in one short transaction, so nothing is pinned while we talk to the
      // Banking API. The partial unique index admits exactly one claimant; a
      // loser gets a 409 in about a millisecond rather than waiting.
      return await withSyncRun(
        this.pool,
        userId,
        'api',
        async (run) => {
          // Both halves are re-read in full on every run: the account list from
          // the API (never from the local mirror), and then every account's whole
          // transaction range. Neither is incremental — see the class notes.
          /**
           * The deadline as a signal, not just a check between pages.
           *
           * Checking at page boundaries bounds the gaps between requests but
           * not a request itself: one page can consume the whole retry budget,
           * and `listAccounts` runs before the first check at all. Handing the
           * banking client a signal makes the deadline apply INSIDE the call,
           * which is what the reclaim rule assumes when it treats a live run as
           * always stopping before its slot is taken.
           */
          const abort = new AbortController();
          const deadlineTimer = setTimeout(
            () => {
              abort.abort(new Error('Sync deadline exceeded'));
            },
            Math.max(0, this.deadlineMs - run.elapsedMs()),
          );
          // Never keep the process alive just to fire a cancellation.
          deadlineTimer.unref();

          try {
            const range = await this.banking.getDataRange();
            const accounts = await this.banking.listAccounts(userId, abort.signal);

            await this.db
              .insert(schema.accounts)
              .values(
                accounts.map((a) => ({
                  id: a.id,
                  userId,
                  name: a.name ?? null,
                  type: a.type,
                  currency: a.currency,
                  currentBalance: a.balance.toFixed(2),
                  lastSyncedAt: new Date(),
                })),
              )
              // Every mutable field is written back, not just the balance. `type` in
              // particular drives transfer classification — a stale one would make
              // a savings account look like a current account and quietly
              // misclassify every transfer into it.
              .onConflictDoUpdate({
                target: schema.accounts.id,
                set: {
                  name: sql`excluded.name`,
                  type: sql`excluded.type`,
                  currency: sql`excluded.currency`,
                  currentBalance: sql`excluded.current_balance`,
                  lastSyncedAt: sql`excluded.last_synced_at`,
                },
              });

            const totals = { fresh: 0, duplicate: 0, amended: 0, pages: 0 };
            const covered: string[] = [];
            let failed = 0;
            let timedOut = false;
            // Per RUN, never on `this`. SyncService is constructed once for the app
            // and shared by every request, so instance state here would let one
            // user's failure be written into another user's audit row.
            let lastError: string | undefined;

            for (const account of accounts) {
              // An upstream sick enough to push us past the deadline is one to back
              // away from, not to keep hammering. Stop, keep what committed, and
              // let the next sync pick up the rest — every run re-reads the whole
              // range anyway, so nothing is lost by stopping early.
              if (run.isPastDeadline()) {
                timedOut = true;
                break;
              }
              try {
                for await (const page of this.banking.streamTransactions(
                  account.id,
                  range,
                  abort.signal,
                )) {
                  // One transaction per page, not one for the whole user: a crash
                  // on page 40 keeps pages 1-39.
                  const counts = await this.writePage(page, userId, run.runId);
                  totals.fresh += counts.fresh;
                  totals.duplicate += counts.duplicate;
                  totals.amended += counts.amended;
                  totals.pages += 1;
                  if (run.isPastDeadline()) {
                    timedOut = true;
                    break;
                  }
                }
                // Listed only after the walk reached a null cursor. A partial walk
                // is a random subset of the range, so it proves nothing — and a walk
                // cut short by the deadline is exactly that.
                if (!timedOut) covered.push(account.id);
              } catch (err) {
                failed += 1;
                lastError = err instanceof Error ? err.message : String(err);
                this.log.error(
                  { err, userId, accountId: account.id, syncRunId: run.runId },
                  'account walk failed; it will not be marked covered',
                );
                syncAccountFailures.add(1, { reason: classifyFailure(err) });
              }
            }

            // Every account we never finished counts as failed, so coverage and the
            // response agree with each other.
            if (timedOut) {
              failed = accounts.length - covered.length;
              lastError =
                `Aborted after ${String(Math.round(run.elapsedMs() / 1000))}s: the sync deadline ` +
                `passed with the Banking API still responding slowly. Retry later.`;
            }

            // Refreshed here, not on the scoring path: this code is already talking
            // to the Banking API and scoring should not have to.
            try {
              await this.categories.refreshFromUpstream();
            } catch (err) {
              // A concurrent sync minting the same next version loses on the
              // primary key. That is benign — the other run stored the same
              // dictionary — but it must not look the same as an upstream that
              // has started returning garbage, which is why it is classified
              // rather than swallowed.
              const lost = isUniqueViolation(err);
              this.log[lost ? 'debug' : 'warn'](
                { err, userId },
                lost
                  ? 'category dictionary refresh lost a race; another sync stored it'
                  : 'category dictionary refresh FAILED; scoring will use the last stored version',
              );
              categoryRefreshFailures.add(1, { reason: lost ? 'lost_race' : 'upstream' });
            }
            // Recorded whether or not that refresh succeeded: what scoring needs
            // is the version in force when this run finished, which is the newest
            // one held locally either way.
            const categoryVersion = await this.categories.currentVersion();

            const status = failed === 0 ? 'succeeded' : 'partial';

            syncRunsTotal.add(1, { status, ...(timedOut && { reason: 'deadline' }) });
            syncDuration.record((Date.now() - startedAt) / 1000, { status });
            syncTransactionsTotal.add(totals.fresh, { outcome: 'new' });
            syncTransactionsTotal.add(totals.duplicate, { outcome: 'duplicate' });
            syncTransactionsTotal.add(totals.amended, { outcome: 'amended' });
            // Separate from the `amended` outcome above deliberately: this one is
            // an alarm, not an accounting line. Non-zero means upstream mutated
            // rows we had already stored.
            if (totals.amended > 0) transactionAmendmentsTotal.add(totals.amended);

            await run.finish(status, {
              ...(categoryVersion !== null && { categoryVersion }),
              syncedAccounts: accounts.length,
              newTransactions: totals.fresh,
              duplicateTransactions: totals.duplicate,
              amendedTransactions: totals.amended,
              pagesFetched: totals.pages,
              accountsCompleted: covered.length,
              accountsFailed: failed,
              syncedFrom: range.from,
              coversThrough: range.to,
              coveredAccountIds: covered,
              ...(lastError ? { error: lastError } : {}),
            });

            return {
              user_id: userId,
              synced_accounts: accounts.length,
              new_transactions: totals.fresh,
              duplicate_transactions: totals.duplicate,
              amended_transactions: totals.amended,
              synced_from: range.from,
              synced_to: range.to,
              status,
              sync_run_id: run.runId,
              accounts_failed: failed,
              warnings: [
                ...(failed > 0
                  ? [
                      `${String(failed)} account(s) did not finish; scoring will refuse until re-synced`,
                    ]
                  : []),
                ...(timedOut
                  ? ['Sync aborted on its deadline; upstream was too slow. Retry later.']
                  : []),
              ],
            };
          } finally {
            clearTimeout(deadlineTimer);
          }
        },
        { deadlineMs: this.deadlineMs },
      );
    } catch (err) {
      if (err instanceof ConflictError) {
        // Contention is expected traffic, not an incident — but a client stuck
        // in a retry loop is invisible without this. A rejected attempt never
        // ran, so it is NOT counted in syncRunsTotal.
        syncConflictsTotal.add(1, { 'user.id': userId });
      } else {
        // The run threw: `withSyncRun` has already driven the row to `failed`,
        // but the success path's counter never fired, so record it here or the
        // failure rate silently reads as zero.
        syncRunsTotal.add(1, { status: 'failed' });
        syncDuration.record((Date.now() - startedAt) / 1000, { status: 'failed' });
      }
      throw err;
    }
  }

  /**
   * Writes one page, resolving conflicts by content hash rather than ignoring
   * them, and archiving the prior row whenever the hash moves.
   *
   * Returns the split between genuinely new rows, unchanged duplicates, and
   * upstream amendments — which is what makes an amendment visible instead of
   * silent.
   */
  private async writePage(
    page: readonly BankingTransaction[],
    userId: string,
    syncRunId: string,
  ): Promise<{ fresh: number; duplicate: number; amended: number }> {
    if (page.length === 0) return { fresh: 0, duplicate: 0, amended: 0 };

    const rows = page.map((t) => ({
      id: t.id,
      accountId: t.account_id,
      userId,
      bookedAt: t.date,
      amount: t.amount.toFixed(2),
      currency: t.currency,
      description: t.description ?? null,
      merchant: t.merchant_name ?? null,
      category: t.merchant_category_code ?? null,
      // The API states the direction explicitly and also encodes it in the
      // sign. Trust `type`, and let the sign disagree loudly if it ever does.
      isCredit: t.type === 'credit',
      contentHash: contentHashOf(t),
    }));

    return this.db.transaction(async (tx) => {
      // Archive the prior state of every row whose content actually changed,
      // BEFORE overwriting it.
      await tx.execute(sql`
        INSERT INTO transaction_revisions
          (id, transaction_id, revision, content_hash, previous,
           detected_by_sync_id, detected_at)
        SELECT gen_random_uuid()::text, t.id, t.revision + 1, t.content_hash,
               to_jsonb(t), ${syncRunId}, now()
          FROM transactions t
          JOIN (VALUES ${sql.join(
            rows.map((r) => sql`(${r.id}, ${r.contentHash})`),
            sql`, `,
          )}) AS incoming(id, content_hash) ON incoming.id = t.id
         WHERE t.content_hash IS DISTINCT FROM incoming.content_hash
      `);

      const before = await tx.execute<{ id: string; content_hash: string }>(
        sql`SELECT id, content_hash FROM transactions WHERE id IN (${sql.join(
          rows.map((r) => sql`${r.id}`),
          sql`, `,
        )})`,
      );
      const existing = new Map(before.rows.map((r) => [r.id, r.content_hash]));

      await tx
        .insert(schema.transactions)
        .values(rows)
        .onConflictDoUpdate({
          target: schema.transactions.id,
          set: {
            amount: sql`excluded.amount`,
            bookedAt: sql`excluded.booked_at`,
            category: sql`excluded.category`,
            merchant: sql`excluded.merchant`,
            description: sql`excluded.description`,
            isCredit: sql`excluded.is_credit`,
            contentHash: sql`excluded.content_hash`,
            revision: sql`transactions.revision + 1`,
            updatedAt: sql`now()`,
          },
          setWhere: sql`transactions.content_hash IS DISTINCT FROM excluded.content_hash`,
        });

      let fresh = 0;
      let duplicate = 0;
      let amended = 0;
      for (const r of rows) {
        const prior = existing.get(r.id);
        if (prior === undefined) fresh += 1;
        else if (prior === r.contentHash) duplicate += 1;
        else amended += 1;
      }
      return { fresh, duplicate, amended };
    });
  }
}

/**
 * Digest of the fields a score depends on.
 *
 * Deliberately excludes `description`: upstream enriches merchant descriptors
 * without changing what the transaction means, and treating that as an
 * amendment would bury real changes in noise.
 */
function contentHashOf(t: BankingTransaction): string {
  return createHash('sha256')
    .update(
      [t.id, t.date, t.amount.toFixed(2), t.currency, t.merchant_category_code ?? '', t.type].join(
        '|',
      ),
    )
    .digest('hex');
}
