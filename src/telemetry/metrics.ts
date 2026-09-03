import { metrics } from '@opentelemetry/api';

/**
 * The automatic instrumentation says the service is HEALTHY; these say it is
 * CORRECT. It can be 100% available, p99 30ms, zero errors, and handing out
 * scores from three-week-old data. Counters carry no `.total`.
 */
const meter = metrics.getMeter('credit-builder');

export const syncRunsTotal = meter.createCounter('sync.runs', {
  description: 'Sync attempts by terminal status (succeeded | partial | failed)',
});

export const syncDuration = meter.createHistogram('sync.duration', {
  description: 'Wall-clock duration of a full user sync',
  unit: 's',
});

export const syncTransactionsTotal = meter.createCounter('sync.transactions', {
  description: 'Transactions written, by outcome (new | duplicate | amended | reversed)',
});

export const transactionAmendmentsTotal = meter.createCounter('sync.amendments', {
  description: 'Transactions whose upstream content changed after we stored them',
});

export const syncConflictsTotal = meter.createCounter('sync.conflicts', {
  description: 'Sync requests rejected with 409 because a sync was already running',
});

export const syncRunsReclaimedTotal = meter.createCounter('sync.reclaims', {
  description: 'Stale running sync rows reclaimed as abandoned after a process death',
});

export const syncAccountFailures = meter.createCounter('sync.account_failures', {
  description: 'Account walks that failed, by coarse failure class',
});

export const categoryRefreshFailures = meter.createCounter('sync.category_refresh_failures', {
  description: 'Failed merchant category refreshes, by reason (lost_race | upstream)',
});

export const bankingApiRequests = meter.createCounter('banking.requests', {
  description: 'Banking API calls by endpoint and status class',
});

export const bankingApiRetries = meter.createCounter('banking.retries', {
  description: 'Retried Banking API calls by reason (5xx | 429 | timeout | transport)',
});

export const scoresComputedTotal = meter.createCounter('scoring.scores', {
  description: 'Scores served, by band and model version',
});

export const scoreDuration = meter.createHistogram('scoring.duration', {
  description: 'Time to compute a reliability index, excluding I/O',
  unit: 'ms',
});

export const scoringRefusedTotal = meter.createCounter('scoring.refusals', {
  description: 'Scoring requests refused for incomplete coverage, by gap reason',
});

export const scoringCoverageShortfallDays = meter.createHistogram('scoring.coverage_shortfall', {
  description: 'Days by which coverage fell short of the requested window',
  unit: 'd',
});

export const scoreDistribution = meter.createHistogram('scoring.reliability_index', {
  description: 'Distribution of the reliability index values served (0-100)',
});

/** Fairness: a component scoring zero measures what we see, not reliability. */
export const componentZeroTotal = meter.createCounter('scoring.component_zeros', {
  description: 'Times a scoring component contributed zero, by component and volume cohort',
});

export const transfersExcluded = meter.createHistogram('scoring.transfers_excluded', {
  description: 'Own-account movements excluded from income when scoring',
});

export const categoryDictionaryAge = meter.createGauge('scoring.category_dictionary.age', {
  description: 'Age of the merchant category dictionary backing scoring decisions',
  unit: 's',
});
