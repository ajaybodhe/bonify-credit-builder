import type pg from 'pg';
import type { Database } from '../../db/client.js';
import { randomUUID } from 'node:crypto';
import { withReadSnapshot } from '../../db/read-snapshot.js';
import { assessCoverage, requireCompleteCoverage, type Coverage } from './coverage.js';
import { scoringWindow, type ScoringWindow } from '../../lib/date.js';
import { scoreSnapshots, type Transaction } from '../../db/schema.js';
import { classifyTransfers, type AccountType } from './transfers.js';
import { hashScoringInputs } from './reconstruct.js';
import { CURRENT_MODEL_VERSION, modelFor } from './models/index.js';
import type { ReliabilityResponse } from './schemas.js';
import type { CategoryResolver } from './categories.js';
import type { DataQualityService } from './data-quality.js';
import {
  categoryDictionaryAge,
  componentZeroTotal,
  scoreDistribution,
  scoreDuration,
  scoresComputedTotal,
  scoringCoverageShortfallDays,
  scoringRefusedTotal,
  transfersExcluded,
} from '../../telemetry/metrics.js';
import { daysBetween } from '../../lib/date.js';
import { AppError } from '../../lib/errors.js';

/**
 * Orchestrates a scoring request: resolve the window, load the local
 * transactions for it, resolve essential/high-risk categories, run the pure
 * model, persist a snapshot, and shape the response.
 *
 * Deliberately thin. Anything that involves a decision about the score belongs
 * in scoring.ts, where it can be tested without a database.
 */
export class ReliabilityService {
  constructor(
    private readonly db: Database,
    /** Raw pool: the read snapshot needs a dedicated client, not the pooled ORM. */
    private readonly pool: pg.Pool,
    private readonly categories: CategoryResolver,
    private readonly dataQuality: DataQualityService,
  ) {}

  /**
   * **No lock, unlike sync.** Scoring is idempotent and the model pure, so two
   * simultaneous requests should produce the same score. What does need
   * handling is subtler: all reads share one REPEATABLE READ snapshot, or a
   * sync committing mid-request yields a plausible score whose `input_hash`
   * describes a state that never existed; and two identical requests racing to
   * insert the same snapshot is `ON CONFLICT DO NOTHING`, not an error.
   *
   * **Coverage is a gate, not a caveat.** Anything short of the full window for
   * every account is `409 SYNC_REQUIRED` naming the gap — see `coverage.ts`.
   *
   * **It never triggers a sync.** Making a read write would give an
   * unpredictable latency profile, race concurrent requests to sync one user,
   * and couple credit decisions to upstream availability. Freshness is the
   * caller's decision; `data_quality` reports what the history actually covers.
   */
  async getReliability(userId: string, from: string): Promise<ReliabilityResponse> {
    const window = scoringWindow(from);

    // Every read that feeds the score happens on THIS client, inside one MVCC
    // snapshot. Collaborators are handed the client rather than using their own
    // handle — a different handle would observe a different instant, which is
    // exactly the read skew the snapshot prevents.
    const gathered = await withReadSnapshot(this.pool, async (client) => {
      // The gate comes FIRST, before any transaction is loaded. Refusing early
      // is cheaper and clearer: there is no half-built score to discard, and no
      // later branch that could quietly score the partial set.
      const coverage = await assessCoverage(client, userId, window);
      try {
        requireCompleteCoverage(coverage, window);
      } catch (err) {
        recordRefusal(coverage, window);
        throw err;
      }

      const { rows: txns } = await client.query<Transaction>(
        `SELECT id, account_id AS "accountId", user_id AS "userId",
                booked_at::text AS "bookedAt", amount, currency, description, merchant,
                category, is_credit AS "isCredit", status, content_hash AS "contentHash",
                revision
           FROM transactions
          WHERE user_id = $1 AND status = 'active'
            AND booked_at BETWEEN $2::date AND $3::date`,
        [userId, window.start, window.end],
      );

      /**
       * The provider reports ONE balance, undated, and it does not reconcile
       * with the transactions it publishes: `acc_1001_chk` reads €2,450 while
       * carrying +€8,749 of net inflow after the window closes. So the balance
       * is a standalone figure, not the end state of the ledger.
       *
       * That rules out rolling it back over later movement. Doing so drives
       * the account to −€14,712 and makes every day of the window negative —
       * an artefact of arithmetic on two numbers that were never reconciled.
       * Anchoring it at the window's end is the least-wrong reading available,
       * and `negative_balance_days` is documented as an estimate because of it.
       */
      // One round trip: balance and type are both per-account columns, and the
      // model needs both. Two queries here meant two scans and two round trips
      // for the same rows.
      const { rows: accountRows } = await client.query<{
        id: string;
        type: string | null;
        balance: string | null;
      }>(
        `SELECT a.id, a.type, a.current_balance::text AS balance
           FROM accounts a
          WHERE a.user_id = $1`,
        [userId],
      );

      // Only for provenance on the snapshot: which run's data was scored.
      const { rows: lastRun } = await client.query<{ id: string }>(
        `SELECT id FROM sync_runs
          WHERE user_id = $1 AND status IN ('succeeded','partial')
          ORDER BY started_at DESC LIMIT 1`,
        [userId],
      );

      /**
       * Categories are PINNED to the sync, not resolved fresh.
       *
       * Transactions carry raw merchant category codes; the mapping from code
       * to group is applied here, and it decides every scoring semantic.
       * Resolving it at scoring time would interpret a synced dataset with a
       * mapping it was never synced under — and would put an outbound call on
       * the one path that must not have one, so that a credit decision never
       * inherits the Banking API's availability.
       */
      // From the run that COVERS the window, not merely the newest run — see
      // `assessCoverage`. Coverage composes across runs, so the two differ.
      const pinnedVersion = coverage.category_version;
      if (pinnedVersion === null) {
        throw new AppError(
          'CATEGORIES_UNAVAILABLE',
          503,
          'The sync covering this window recorded no merchant category dictionary, so ' +
            'the essential-category list is unknown and component C is undefined. ' +
            'Re-sync to fetch one.',
        );
      }
      const categories = await this.categories.forVersion(pinnedVersion, client);
      const dataQuality = await this.dataQuality.assess(
        client,
        userId,
        window,
        coverage,
        (Date.now() - categories.fetchedAt.getTime()) / 3_600_000,
      );

      return {
        txns,
        accounts: accountRows,
        categories,
        dataQuality,
        syncRunId: lastRun[0]?.id ?? null,
      };
    });

    // Outside the snapshot, deliberately: the model is pure and needs no
    // database, and the snapshot INSERT is a write that a READ ONLY
    // transaction would reject.
    const accountTypes = new Map<string, AccountType>(
      gathered.accounts.map((a) => [a.id, a.type === 'savings' ? 'savings' : 'checking']),
    );
    const transfers = classifyTransfers(
      gathered.txns,
      accountTypes,
      new Set(gathered.categories.savings),
    );

    // Excludes I/O: this times the MODEL, so a regression in the arithmetic is
    // not masked by a slow database.
    const modelStartedAt = performance.now();
    // Named rather than inlined: the same map is scored, hashed and stored, and
    // it must be the identical object in all three or the audit trail lies.
    const closingBalances = Object.fromEntries(
      gathered.accounts.map((a) => [a.id, a.balance ?? '0.00']),
    );

    const result = modelFor(CURRENT_MODEL_VERSION).compute({
      window,
      transactions: gathered.txns,
      transfers,
      categories: gathered.categories,
      closingBalances,
    });

    scoreDuration.record(performance.now() - modelStartedAt);
    scoresComputedTotal.add(1, {
      band: result.score_band,
      'model.version': String(result.model_version),
    });
    scoreDistribution.record(result.reliability_index);
    transfersExcluded.record(transfers.excludedFromIncome.size);
    categoryDictionaryAge.record((Date.now() - gathered.categories.fetchedAt.getTime()) / 1000, {
      'category.version': String(gathered.categories.version),
    });

    // Fairness instrumentation. A component that reads zero far more often for
    // low-volume users is measuring how much of a life we can SEE, not how
    // reliable that life is — the cohort label is what makes the difference
    // visible. See docs/scoring-model.md.
    const cohort = volumeCohort(gathered.txns.length);
    // Named explicitly rather than iterating `components`, which also holds
    // `transfers_excluded_from_income` (a count, not a component, and usually
    // 0), `net_savings` (a string, so never === 0), and a nested
    // `resilience_breakdown` the old loop never looked inside. Scoring zero on
    // resilience's savings term is exactly the signal this metric is for.
    const scored: Record<string, number> = {
      income_regularity: result.components.income_regularity_points,
      income_coverage: result.components.income_coverage_points,
      essential_consistency: result.components.essential_consistency_points,
      resilience: result.components.resilience_points,
      resilience_savings: result.components.resilience_breakdown.savings,
    };
    for (const [component, value] of Object.entries(scored)) {
      if (value === 0) componentZeroTotal.add(1, { component, cohort });
    }

    const inputHash = hashScoringInputs(
      gathered.txns.map((t) => ({
        id: t.id,
        booked_at: t.bookedAt,
        amount: t.amount,
        category: t.category,
        is_credit: t.isCredit,
        account_id: t.accountId,
        user_id: t.userId,
        currency: t.currency,
        description: t.description,
        merchant: t.merchant,
        status: t.status,
        content_hash: t.contentHash,
        revision: t.revision,
      })),
      closingBalances,
    );

    // Concurrent identical requests both compute the same score and both try to
    // insert it. One wins; the other is a no-op, not an error.
    await this.db
      .insert(scoreSnapshots)
      .values({
        id: randomUUID(),
        userId,
        windowStart: window.start,
        windowEnd: window.end,
        modelVersion: result.model_version,
        categoryVersion: gathered.categories.version,
        reliabilityIndex: result.reliability_index,
        scoreBand: result.score_band,
        metrics: result.metrics,
        components: result.components,
        drivers: result.drivers,
        inputHash,
        closingBalances,
        dataQuality: gathered.dataQuality,
        syncRunId: gathered.syncRunId,
      })
      .onConflictDoNothing();

    return {
      user_id: userId,
      from,
      currency: 'EUR',
      reliability_index: result.reliability_index,
      score_band: result.score_band,
      metrics: result.metrics,
      // Data-quality caveats join the drivers so an analyst reading the
      // explanation cannot miss them.
      drivers: [...result.drivers, ...gathered.dataQuality.warnings],
      data_quality: gathered.dataQuality,
      model_version: result.model_version,
    };
  }
}

/**
 * Buckets, not raw counts: the cohort is a metric label, and an unbounded label
 * is how a time-series database falls over.
 */
function volumeCohort(transactionCount: number): string {
  if (transactionCount < 50) return 'lt50';
  if (transactionCount < 200) return '50-199';
  if (transactionCount < 500) return '200-499';
  return 'gte500';
}

/**
 * A refusal is the service working as designed, but a RISING refusal rate is
 * the single most important signal it emits: users are asking for scores the
 * sync pipeline cannot support. Attributed by reason so the cause is visible
 * without a query.
 */
function recordRefusal(coverage: Coverage, window: ScoringWindow): void {
  if (coverage.accounts_total === 0) {
    scoringRefusedTotal.add(1, { reason: 'never_synced' });
    return;
  }
  for (const gap of coverage.gaps) scoringRefusedTotal.add(1, { reason: gap.reason });

  // How far short, in days — "the sync is an hour behind" and "we have never
  // fetched this window" both refuse, but they need different responses.
  const shortfall = coverage.covers_through
    ? Math.max(0, daysBetween(coverage.covers_through, window.end))
    : daysBetween(window.start, window.end);
  scoringCoverageShortfallDays.record(shortfall);
}
