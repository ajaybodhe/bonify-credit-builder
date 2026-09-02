import { metrics } from '@opentelemetry/api';

/**
 * Application metrics, declared in one place.
 *
 * The split that matters is **system** vs **business**:
 *
 * - *System* metrics tell you the service is healthy: latency, error rate,
 *   pool saturation. Mostly supplied by the automatic instrumentation.
 * - *Business* metrics tell you the service is CORRECT, which is a different
 *   question and the one that matters for scoring. This service can be 100%
 *   available, p99 30ms, zero errors — and be handing out credit scores
 *   computed from three-week-old data because sync has been quietly failing.
 *
 * Every metric below exists because there is a specific failure it is the only
 * way to see. Documented in docs/architecture-design.md §4.7.
 */
/**
 * Naming: `<domain>.<subject>[.<qualifier>]`. Dots separate hierarchy; an
 * underscore joins a compound noun that is one concept (`reliability_index`,
 * `coverage_shortfall`). Counters are named for the plural thing counted and
 * carry no `.total` — the Prometheus exporter appends `_total` itself, and
 * baking it in yields `sync_runs_total_total`. No name is a prefix of another,
 * which some backends reject.
 */
const meter = metrics.getMeter('credit-builder');

// ------------------------------------------------------------------- sync

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

/**
 * The drift alarm. A non-zero rate means upstream is mutating transactions we
 * already stored, which invalidates the immutability assumption that the dedupe
 * strategy rests on. Nothing else detects this.
 */
export const transactionAmendmentsTotal = meter.createCounter('sync.amendments', {
  description: 'Transactions whose upstream content changed after we stored them',
});

/**
 * Sync requests rejected because one was already running for that user.
 * Contention is expected traffic, not an incident — but a client stuck in a
 * retry loop, or a scheduler racing a manual trigger, is invisible without it.
 */
export const syncConflictsTotal = meter.createCounter('sync.conflicts', {
  description: 'Sync requests rejected with 409 because a sync was already running',
});

/**
 * `running` rows reclaimed as `abandoned`. Non-zero means a process died
 * mid-sync — a crash indicator that no HTTP-level metric can surface, because
 * the request that died never returned a status.
 */
export const syncRunsReclaimedTotal = meter.createCounter('sync.reclaims', {
  description: 'Stale running sync rows reclaimed as abandoned after a process death',
});

/**
 * Accounts whose walk threw. Previously a per-run counter and nothing else, so
 * one account failing every night was invisible.
 */
export const syncAccountFailures = meter.createCounter('sync.account_failures', {
  description: 'Account walks that failed, by coarse failure class',
});

/**
 * Category refreshes that did not store a dictionary. `lost_race` is benign —
 * a concurrent sync stored the same one — while `upstream` means the dictionary
 * feed itself is failing and scores are running on an ageing mapping.
 */
export const categoryRefreshFailures = meter.createCounter('sync.category_refresh_failures', {
  description: 'Failed merchant category refreshes, by reason (lost_race | upstream)',
});

export const bankingApiRequests = meter.createCounter('banking.requests', {
  description: 'Banking API calls by endpoint and status class',
});

export const bankingApiRetries = meter.createCounter('banking.retries', {
  description: 'Retried Banking API calls by reason (5xx | 429 | timeout | transport)',
});

// ---------------------------------------------------------------- scoring

export const scoresComputedTotal = meter.createCounter('scoring.scores', {
  description: 'Scores served, by band and model version',
});

export const scoreDuration = meter.createHistogram('scoring.duration', {
  description: 'Time to compute a reliability index, excluding I/O',
  unit: 'ms',
});

/**
 * The single most important number in the service.
 *
 * Scoring refuses on incomplete coverage (docs/architecture-design.md §4.5),
 * so "scores served on bad
 * data" is no longer reachable — the failure now surfaces as REFUSALS instead.
 * Same underlying problem, opposite side of the gate, and still the one metric
 * to keep if only one were allowed.
 *
 * A rising rate means users are asking for scores the sync pipeline cannot
 * support. Attributed by gap reason, so the cause is visible without a query:
 * `never_synced` points at onboarding or a newly connected account,
 * `ends_too_early` at sync lag, `starts_too_late` at missing backfill.
 */
export const scoringRefusedTotal = meter.createCounter('scoring.refusals', {
  description: 'Scoring requests refused for incomplete coverage, by gap reason',
});

/**
 * Coverage shortfall in days when a request is refused. Distinguishes "the
 * sync is an hour behind" from "we have never fetched this window at all",
 * which need different responses.
 */
export const scoringCoverageShortfallDays = meter.createHistogram('scoring.coverage_shortfall', {
  description: 'Days by which coverage fell short of the requested window',
  unit: 'd',
});

/**
 * Score distribution. Drift in the band mix is the only thing that catches BOTH
 * a bad model deploy and a silent upstream categorisation change — neither of
 * which produces a single error.
 */
export const scoreDistribution = meter.createHistogram('scoring.reliability_index', {
  description: 'Distribution of the reliability index values served (0-100)',
});

/**
 * Fairness instrumentation, not performance instrumentation.
 *
 * A scoring component that returns zero far more often for low-volume users is
 * measuring data availability rather than reliability. That is the concrete,
 * measurable form of the bias described in docs/scoring-model.md, and it is
 * invisible without this counter.
 */
export const componentZeroTotal = meter.createCounter('scoring.component_zeros', {
  description: 'Times a scoring component contributed zero, by component and volume cohort',
});

/**
 * Internal transfers excluded from a score. Worth watching: a sudden drop to
 * zero means the detection stopped matching (an upstream change to amount
 * formatting or booking dates), and scores would start drifting UPWARD — the
 * dangerous direction, because an unfairly high score gets lent against.
 */
export const transfersExcluded = meter.createHistogram('scoring.transfers_excluded', {
  description: 'Own-account movements excluded from income when scoring',
});

export const categoryDictionaryAge = meter.createGauge('scoring.category_dictionary.age', {
  description: 'Age of the merchant category dictionary backing scoring decisions',
  unit: 's',
});
