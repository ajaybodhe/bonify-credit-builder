import type { Transaction } from '../../db/schema.js';
import type { ScoringWindow } from '../../lib/date.js';
import type { Metrics, ScoreBand } from './schemas.js';
import type { TransferClassification } from './transfers.js';
import type { CategoryDictionary } from './categories.js';

/**
 * The scoring contract, and the registry of model versions that implement it.
 *
 * A **model version is a file, kept forever**. `models/v1.ts` is version 1; a
 * change to any constant or to the logic becomes `models/v2.ts` rather than an
 * edit. So `score_snapshots.model_version` is sufficient on its own to say how a
 * past score was produced — nothing about the model needs copying into the row,
 * and a recompute looks the implementation up here.
 *
 * The types below are shared because they are the interface between the service
 * and whichever version runs. Anything that affects a score — constants,
 * formulas, helpers — belongs inside the version file.
 */

/** Per-component breakdown, persisted alongside the score for auditability. */
export interface ScoreComponents {
  income_regularity_points: number;
  income_coverage_points: number;
  essential_consistency_points: number;
  resilience_points: number;
  resilience_breakdown: {
    savings: number;
    negative_balance: number;
    late_fees: number;
    high_risk: number;
  };
  /** Surfaced so an analyst can see the correction was applied, and how much. */
  transfers_excluded_from_income: number;
  /** Net movement into savings (inflow minus outflow) behind D's savings points. */
  net_savings: string;
}

/**
 * The fields the model actually reads.
 *
 * Narrower than the stored row on purpose: `ingestedAt` and `updatedAt` are
 * bookkeeping, not model inputs, and a transaction REBUILT from
 * `transaction_revisions` has neither. Typing this as the full row forced an
 * unchecked cast at the reconstruct boundary — which then hid the two missing
 * fields rather than reporting them.
 */
export type ScoredTransaction = Omit<Transaction, 'ingestedAt' | 'updatedAt'>;

export interface ScoringInput {
  window: ScoringWindow;
  transactions: ScoredTransaction[];
  /**
   * Own-account movements, from `classifyTransfers()`.
   *
   * This provider reports an internal transfer as a single-sided credit into
   * the savings account, so without this A would count it as income and B would
   * add it to the income total. Direction decides the treatment: into savings
   * is saving, out of savings is dis-saving, and anything else contributes
   * nothing either way. Savings is scored on the NET movement.
   */
  transfers: TransferClassification;
  /**
   * The whole dictionary, resolved dynamically from the Banking API — not two
   * hand-picked lists.
   *
   * The whole dictionary rather than two hand-picked lists: component A needs
   * `income` codes and D's late-fee term needs `fees` codes, so anything less
   * leaves category questions unanswerable from `ScoringInput` alone — which is
   * what would make the function pure-looking rather than pure.
   */
  categories: CategoryDictionary;
  /**
   * Latest known balance per account, as a decimal STRING.
   *
   * Money is never a JS number in this codebase: `numeric(14,2)` in Postgres,
   * string in transit, converted to minor units at the edge of the model. A
   * float here would let rounding drift into `negative_balance_days`.
   */
  closingBalances: Readonly<Record<string, string>>;
}

export interface ScoringResult {
  /**
   * Reported by the model itself, so the persisted snapshot records the version
   * that actually ran rather than one the caller believed was running.
   */
  model_version: number;
  reliability_index: number;
  score_band: ScoreBand;
  metrics: Metrics;
  components: ScoreComponents;
  drivers: string[];
}
