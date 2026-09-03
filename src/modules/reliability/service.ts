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

export class ReliabilityService {
  constructor(
    private readonly db: Database,
    private readonly pool: pg.Pool,
    private readonly categories: CategoryResolver,
    private readonly dataQuality: DataQualityService,
  ) {}

  /**
   * No lock, unlike sync. What is needed instead is one REPEATABLE READ snapshot:
   * a sync committing mid-request would yield a plausible score whose `input_hash`
   * describes a state that never existed. Coverage is a gate, and this never
   * triggers a sync — a credit decision must not inherit upstream availability.
   */
  async getReliability(userId: string, from: string): Promise<ReliabilityResponse> {
    const window = scoringWindow(from);

    const gathered = await withReadSnapshot(this.pool, async (client) => {
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
       * The provider reports ONE undated balance that does not reconcile with the
       * transactions it publishes: `acc_1001_chk` reads €2,450 while carrying +€8,749
       * of net inflow after the window closes. Rolling it back over that movement
       * drives it to −€14,712, so it is anchored at the window end and
       * `negative_balance_days` is documented as an estimate.
       */
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

      const { rows: lastRun } = await client.query<{ id: string }>(
        `SELECT id FROM sync_runs
          WHERE user_id = $1 AND status IN ('succeeded','partial')
          ORDER BY started_at DESC LIMIT 1`,
        [userId],
      );

      /** PINNED: resolving here reads data under a mapping it was never synced under. */
      const pinnedVersion = coverage.category_version;
      if (pinnedVersion === null) {
        throw new AppError(
          'CATEGORIES_UNAVAILABLE',
          503,
          'No merchant category dictionary has ever been fetched, so the essential-category ' +
            'list is unknown and component C is undefined. Sync to fetch one.',
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

    const accountTypes = new Map<string, AccountType>(
      gathered.accounts.map((a) => [a.id, a.type === 'savings' ? 'savings' : 'checking']),
    );
    const transfers = classifyTransfers(
      gathered.txns,
      accountTypes,
      new Set(gathered.categories.savings),
    );

    const modelStartedAt = performance.now();
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

    const cohort = volumeCohort(gathered.txns.length);
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
      drivers: [...result.drivers, ...gathered.dataQuality.warnings],
      data_quality: gathered.dataQuality,
      model_version: result.model_version,
    };
  }
}

function volumeCohort(transactionCount: number): string {
  if (transactionCount < 50) return 'lt50';
  if (transactionCount < 200) return '50-199';
  if (transactionCount < 500) return '200-499';
  return 'gte500';
}

function recordRefusal(coverage: Coverage, window: ScoringWindow): void {
  if (coverage.accounts_total === 0) {
    scoringRefusedTotal.add(1, { reason: 'never_synced' });
    return;
  }
  for (const gap of coverage.gaps) scoringRefusedTotal.add(1, { reason: gap.reason });

  const shortfall = coverage.covers_through
    ? Math.max(0, daysBetween(coverage.covers_through, window.end))
    : daysBetween(window.start, window.end);
  scoringCoverageShortfallDays.record(shortfall);
}
