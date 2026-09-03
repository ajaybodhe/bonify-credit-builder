import type { Transaction } from '../../db/schema.js';
import type { ScoringWindow } from '../../lib/date.js';
import type { Metrics, ScoreBand } from './schemas.js';
import type { TransferClassification } from './transfers.js';
import type { CategoryDictionary } from './categories.js';

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
  transfers_excluded_from_income: number;
  net_savings: string;
}

/** Narrower than the stored row: a rebuilt transaction has no `ingestedAt`. */
export type ScoredTransaction = Omit<Transaction, 'ingestedAt' | 'updatedAt'>;

export interface ScoringInput {
  window: ScoringWindow;
  transactions: ScoredTransaction[];
  transfers: TransferClassification;
  /** The whole dictionary: every category question must be answerable from here. */
  categories: CategoryDictionary;
  closingBalances: Readonly<Record<string, string>>;
}

export interface ScoringResult {
  model_version: number;
  reliability_index: number;
  score_band: ScoreBand;
  metrics: Metrics;
  components: ScoreComponents;
  drivers: string[];
}
