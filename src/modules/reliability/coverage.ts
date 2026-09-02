import type pg from 'pg';
import { SyncRequiredError } from '../../lib/errors.js';
import type { ScoringWindow } from '../../lib/date.js';

/**
 * Does synced data completely cover the requested window?
 *
 * **Score only on complete data.** Any gap, however small, is a refusal — 99%
 * is not scored. A reliability index is a six-month statement about a person;
 * computing it over five and a half and labelling the difference in a side
 * field produces a number that looks authoritative and is not. There is no
 * threshold to argue about because a threshold is what invites arguing.
 *
 * Coverage is derived from `sync_runs`, not per-account checkpoints: every run
 * re-walks the same range for every account, so per-account state would hold
 * identical values and serve no resume purpose. A run qualifies when
 *
 *   1. `synced_from <= window.start`     — it asked far enough back
 *   2. `covers_through >= window.end`    — it asked far enough forward
 *   3. `started_at::date >= window.end`  — it looked no earlier than the
 *                                          window's last day
 *
 * Condition 3 is the one that is easy to miss: `covers_through` is what we
 * ASKED for, and `to` may be in the future — the provider publishes into 2027 —
 * so a run that began in January cannot have seen a February transaction. `>=`
 * rather than `>` so a window ending today is scoreable after a sync today;
 * that run saw only part of the final day, which coverage reports rather than
 * hides.
 *
 * The user is covered when the union of `covered_account_ids` across qualifying
 * runs includes every account they hold — so two partial runs covering
 * different accounts add up.
 */

export type GapReason =
  /** No run ever walked this account to completion. */
  | 'never_synced'
  /** Runs that covered it did not reach far enough back. */
  | 'starts_too_late'
  /** Runs that covered it did not reach far enough forward. */
  | 'ends_too_early'
  | 'both_ends_short'
  /**
   * The range was requested, but every run that covered this account began
   * before the window closed — so it cannot have seen the later part.
   */
  | 'synced_before_window_end';

export interface CoverageGap {
  account_id: string;
  /** Widest range any completed run fetched for this account, if any. */
  covered_from: string | null;
  covered_through: string | null;
  /** When the most recent run covering it began — the bound on what it saw. */
  last_synced_at: string | null;
  reason: GapReason;
}

export interface Coverage {
  accounts_total: number;
  accounts_covering: number;
  /**
   * Merchant category dictionary version recorded by the newest run that
   * actually covers the window. Null when no covering run recorded one, which
   * scoring reports as `CATEGORIES_UNAVAILABLE`.
   */
  category_version: number | null;
  /**
   * Coverage rests on a run that started on the window's last day, so that day
   * may be incomplete. Reported to the caller, never a reason to refuse.
   */
  observed_same_day: boolean;
  /** Range every account is confirmed to cover — the intersection, not the union. */
  covers_from: string | null;
  covers_through: string | null;
  gaps: CoverageGap[];
  complete: boolean;
}

/** Widest range and latest look across the runs that walked one account. */
interface AccountFacts {
  from: string | null;
  through: string | null;
  lastStartedOn: string | null;
  lastStartedAt: string | null;
}

function reasonFor(facts: AccountFacts | undefined, window: ScoringWindow): GapReason {
  if (facts?.from == null || facts.through == null) return 'never_synced';
  const lateStart = facts.from > window.start;
  const earlyEnd = facts.through < window.end;
  if (lateStart && earlyEnd) return 'both_ends_short';
  if (lateStart) return 'starts_too_late';
  if (earlyEnd) return 'ends_too_early';
  return 'synced_before_window_end';
}

/**
 * Reads on the caller's client so this joins their MVCC snapshot — coverage and
 * the transactions it describes must be observed at one instant.
 */
export async function assessCoverage(
  client: pg.PoolClient,
  userId: string,
  window: ScoringWindow,
): Promise<Coverage> {
  const accounts = await client.query<{ id: string }>(
    'SELECT id FROM accounts WHERE user_id = $1 ORDER BY id',
    [userId],
  );

  /**
   * Aggregated in Postgres, one row per account — not one per run.
   *
   * The naive form fetches every run the user has ever had and folds them in
   * JS. With hourly syncs that is tens of thousands of rows per scoring
   * request, each carrying a `jsonb` array, to produce a handful of dates.
   * `bool_or` and an ordered `array_agg` do the same fold where the data is.
   */
  const facts = new Map<string, AccountFacts>();
  const covered = new Set<string>();

  const perAccount = await client.query<{
    account_id: string;
    from_date: string | null;
    through_date: string | null;
    last_started_on: string | null;
    last_started_at: string | null;
    covered: boolean | null;
    same_day: boolean | null;
  }>(
    `WITH runs AS (
       SELECT r.synced_from,
              r.covers_through,
              r.started_at,
              (r.started_at AT TIME ZONE 'UTC')::date AS started_on,
              r.covered_account_ids,
              (    r.synced_from   IS NOT NULL
               AND r.covers_through IS NOT NULL
               AND r.synced_from    <= $2::date
               AND r.covers_through >= $3::date
               AND (r.started_at AT TIME ZONE 'UTC')::date >= $3::date) AS qualifies
         FROM sync_runs r
        WHERE r.user_id = $1
          AND r.status IN ('succeeded', 'partial')
     )
     SELECT acc.id                                                        AS account_id,
            min(runs.synced_from)::text                                   AS from_date,
            max(runs.covers_through)::text                                AS through_date,
            (array_agg(runs.started_on::text ORDER BY runs.started_at DESC))[1] AS last_started_on,
            (array_agg(runs.started_at::text ORDER BY runs.started_at DESC))[1] AS last_started_at,
            bool_or(runs.qualifies)                                       AS covered,
            bool_or(runs.qualifies AND runs.started_on = $3::date)        AS same_day
       FROM runs
       CROSS JOIN LATERAL jsonb_array_elements_text(runs.covered_account_ids) AS acc(id)
      GROUP BY acc.id`,
    [userId, window.start, window.end],
  );

  let sameDayObservation = false;
  for (const row of perAccount.rows) {
    if (row.covered) covered.add(row.account_id);
    if (row.same_day) sameDayObservation = true;
    facts.set(row.account_id, {
      from: row.from_date,
      through: row.through_date,
      lastStartedOn: row.last_started_on,
      lastStartedAt: row.last_started_at,
    });
  }

  /**
   * The dictionary version to score with: from a run that actually establishes
   * coverage, not simply the newest run. One indexed row, not a scan folded in
   * memory.
   */
  const pinned = await client.query<{ category_version: number }>(
    `SELECT category_version
       FROM sync_runs
      WHERE user_id = $1
        AND status IN ('succeeded', 'partial')
        AND category_version IS NOT NULL
        AND synced_from    <= $2::date
        AND covers_through >= $3::date
        AND (started_at AT TIME ZONE 'UTC')::date >= $3::date
        AND jsonb_array_length(covered_account_ids) > 0
      ORDER BY started_at DESC
      LIMIT 1`,
    [userId, window.start, window.end],
  );
  const pinnedCategoryVersion = pinned.rows[0]?.category_version ?? null;

  const gaps: CoverageGap[] = [];
  for (const { id } of accounts.rows) {
    if (covered.has(id)) continue;
    const f = facts.get(id);
    gaps.push({
      account_id: id,
      covered_from: f?.from ?? null,
      covered_through: f?.through ?? null,
      last_synced_at: f?.lastStartedAt ?? null,
      reason: reasonFor(f, window),
    });
  }

  // The range we can vouch for is what EVERY account has — the intersection, so
  // `max(from)` and `min(through)`. One account fetched only from January limits
  // the whole user to January, however far back the others reach.
  //
  // Reported whether or not coverage is complete: it is most useful in the
  // refusal, where it tells the caller what they actually have. Null only when
  // some account has never been fetched at all, because then the intersection
  // genuinely is empty.
  const all = accounts.rows.map((a) => facts.get(a.id));
  const known = all.filter((f): f is AccountFacts => f !== undefined);
  const everyAccountFetched = known.length === accounts.rows.length && accounts.rows.length > 0;
  const froms = known.map((f) => f.from).filter((d): d is string => d !== null);
  const throughs = known.map((f) => f.through).filter((d): d is string => d !== null);

  return {
    accounts_total: accounts.rows.length,
    accounts_covering: accounts.rows.length - gaps.length,
    category_version: pinnedCategoryVersion,
    observed_same_day: sameDayObservation,
    covers_from:
      everyAccountFetched && froms.length ? froms.reduce((a, b) => (a > b ? a : b)) : null,
    covers_through:
      everyAccountFetched && throughs.length ? throughs.reduce((a, b) => (a < b ? a : b)) : null,
    gaps,
    // A user with no accounts is NOT covered: nothing was ever synced for them.
    complete: accounts.rows.length > 0 && gaps.length === 0,
  };
}

/** Throws `SyncRequiredError` unless every account fully spans the window. */
export function requireCompleteCoverage(coverage: Coverage, window: ScoringWindow): void {
  if (coverage.complete) return;

  const message =
    coverage.accounts_total === 0
      ? 'No synced accounts for this user. Sync before scoring.'
      : `Synced data does not cover ${window.start}..${window.end} for ` +
        `${String(coverage.gaps.length)} of ${String(coverage.accounts_total)} account(s). ` +
        'Sync, then retry.';

  throw new SyncRequiredError(message, {
    window: { start: window.start, end: window.end },
    covered: { from: coverage.covers_from, through: coverage.covers_through },
    accounts_total: coverage.accounts_total,
    accounts_covering: coverage.accounts_covering,
    gaps: coverage.gaps,
    remedy: 'POST /api/users/{userId}/sync',
  });
}
