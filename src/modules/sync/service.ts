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

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

// Coarse buckets — never the message, which can carry account ids.
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
 * Pulls one user's accounts and transactions into the local store. Invariants,
 * reasoned through in docs/architecture-design.md §4.4-4.6:
 * 1. Dedupe compares `content_hash` rather than DO NOTHING — banks amend.
 * 2. Both are re-read in full every run; no incremental mode, because an
 *    amendment only shows up on a row re-read.
 * 3. Commit per page: a crash on page 40 keeps pages 1-39.
 * 4. Only accounts walked to completion go in `covered_account_ids`.
 * 5. Record the run whatever happens.
 */
export class SyncService {
  constructor(
    private readonly db: Database,
    private readonly banking: BankingApiClient,
    private readonly pool: pg.Pool,
    private readonly categories: CategoryResolver,
    private readonly log: Logger,
    private readonly deadlineMs: number = SYNC_DEADLINE_MS,
  ) {}

  /** A second concurrent call gets a 409. The range covers the whole `data_range`. */
  async syncUser(userId: string): Promise<SyncResponse> {
    const startedAt = Date.now();
    try {
      return await withSyncRun(
        this.pool,
        userId,
        'api',
        async (run) => {
          // A signal, not a page-boundary check: one page can consume the whole retry budget.
          const abort = new AbortController();
          const deadlineTimer = setTimeout(
            () => {
              abort.abort(new Error('Sync deadline exceeded'));
            },
            Math.max(0, this.deadlineMs - run.elapsedMs()),
          );
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
            // Per RUN: the service is shared, so instance state would leak across users.
            let lastError: string | undefined;

            for (const account of accounts) {
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
                // Invariant 4: a walk cut short by the deadline is a partial walk.
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

            if (timedOut) {
              failed = accounts.length - covered.length;
              lastError =
                `Aborted after ${String(Math.round(run.elapsedMs() / 1000))}s: the sync deadline ` +
                `passed with the Banking API still responding slowly. Retry later.`;
            }

            try {
              await this.categories.refreshFromUpstream();
            } catch (err) {
              const lost = isUniqueViolation(err);
              this.log[lost ? 'debug' : 'warn'](
                { err, userId },
                lost
                  ? 'category dictionary refresh lost a race; another sync stored it'
                  : 'category dictionary refresh FAILED; scoring will use the last stored version',
              );
              categoryRefreshFailures.add(1, { reason: lost ? 'lost_race' : 'upstream' });
            }
            const categoryVersion = await this.categories.currentVersion();

            const status = failed === 0 ? 'succeeded' : 'partial';

            syncRunsTotal.add(1, { status, ...(timedOut && { reason: 'deadline' }) });
            syncDuration.record((Date.now() - startedAt) / 1000, { status });
            syncTransactionsTotal.add(totals.fresh, { outcome: 'new' });
            syncTransactionsTotal.add(totals.duplicate, { outcome: 'duplicate' });
            syncTransactionsTotal.add(totals.amended, { outcome: 'amended' });
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
        syncConflictsTotal.add(1, { 'user.id': userId });
      } else {
        syncRunsTotal.add(1, { status: 'failed' });
        syncDuration.record((Date.now() - startedAt) / 1000, { status: 'failed' });
      }
      throw err;
    }
  }

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
      // Trust `type`; let the sign disagree loudly if it ever does.
      isCredit: t.type === 'credit',
      contentHash: contentHashOf(t),
    }));

    return this.db.transaction(async (tx) => {
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
 * Digest of the fields a score depends on. Excludes `description`: upstream
 * enriches descriptors without changing meaning, and treating that as an
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
