import type pg from 'pg';
import { SyncRequiredError } from '../../lib/errors.js';
import type { ScoringWindow } from '../../lib/date.js';

/**
 * Does synced data completely cover the requested window? Any gap is a refusal:
 * 99% is not scored, because six months computed over five and a half looks
 * authoritative and is not.
 * A run qualifies when it asked far enough back, far enough forward, AND started
 * no earlier than the window's last day — `to` may be in the future, so a January
 * run cannot have seen a February transaction.
 */

export type GapReason =
  | 'never_synced'
  | 'starts_too_late'
  | 'ends_too_early'
  | 'both_ends_short'
  | 'synced_before_window_end';

export interface CoverageGap {
  account_id: string;
  covered_from: string | null;
  covered_through: string | null;
  last_synced_at: string | null;
  reason: GapReason;
}

export interface Coverage {
  accounts_total: number;
  accounts_covering: number;
  category_version: number | null;
  category_version_is_fallback: boolean;
  /** The window’s last day may be incomplete. Reported, never a refusal. */
  observed_same_day: boolean;
  covers_from: string | null;
  covers_through: string | null;
  gaps: CoverageGap[];
  complete: boolean;
}

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

export async function assessCoverage(
  client: pg.PoolClient,
  userId: string,
  window: ScoringWindow,
): Promise<Coverage> {
  const accounts = await client.query<{ id: string }>(
    // Only `active`: a dormant account is gone upstream and can never be
    // re-fetched, so requiring coverage for it would refuse the user forever.
    "SELECT id FROM accounts WHERE user_id = $1 AND status = 'active' ORDER BY id",
    [userId],
  );

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

  // The covering run's version, else the newest: the dictionary is global with no
  // date dimension, so a missing pin must not refuse a score. The caller is told.
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

  let pinnedCategoryVersion = pinned.rows[0]?.category_version ?? null;
  let categoryVersionIsFallback = false;
  if (pinnedCategoryVersion === null) {
    const newest = await client.query<{ version: number }>(
      'SELECT version FROM merchant_category_versions ORDER BY version DESC LIMIT 1',
    );
    pinnedCategoryVersion = newest.rows[0]?.version ?? null;
    categoryVersionIsFallback = pinnedCategoryVersion !== null;
  }

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

  // The intersection: one account fetched only from January limits the whole user.
  const all = accounts.rows.map((a) => facts.get(a.id));
  const known = all.filter((f): f is AccountFacts => f !== undefined);
  const everyAccountFetched = known.length === accounts.rows.length && accounts.rows.length > 0;
  const froms = known.map((f) => f.from).filter((d): d is string => d !== null);
  const throughs = known.map((f) => f.through).filter((d): d is string => d !== null);

  return {
    accounts_total: accounts.rows.length,
    accounts_covering: accounts.rows.length - gaps.length,
    category_version: pinnedCategoryVersion,
    category_version_is_fallback: categoryVersionIsFallback,
    observed_same_day: sameDayObservation,
    covers_from:
      everyAccountFetched && froms.length ? froms.reduce((a, b) => (a > b ? a : b)) : null,
    covers_through:
      everyAccountFetched && throughs.length ? throughs.reduce((a, b) => (a < b ? a : b)) : null,
    gaps,
    complete: accounts.rows.length > 0 && gaps.length === 0,
  };
}

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
