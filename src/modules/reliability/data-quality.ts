import type pg from 'pg';
import type { ScoringWindow } from '../../lib/date.js';
import type { Coverage } from './coverage.js';

/**
 * Answers the question a scoring request cannot avoid: *is the local data good
 * enough to base a credit decision on?*
 *
 * The service scores from a local mirror, so a score is only ever as good as
 * the last sync. Returning a confident `reliability_index: 48` computed from a
 * history missing three weeks — because a sync died on page 40 — is the single
 * worst failure this service can have: it is indistinguishable from a correct
 * answer.
 *
 * Coverage is therefore a GATE, not a caveat — see `coverage.ts`. This module
 * describes the data behind a score that *was* served: how fresh it is, how
 * many accounts, how old the category dictionary is. It is attached to the
 * response and stored on the snapshot, so a past decision can be explained.
 */

/**
 * What a SERVED score can report.
 *
 * Only two values, because coverage is now a gate rather than a caveat: a
 * score is never returned unless every account fully spans the window (see
 * `coverage.ts`). Anything less is a `409 SYNC_REQUIRED`, so `partial` and
 * `never_synced` are not reachable in a 200 response and no longer exist here.
 *
 * `stale` does NOT mean the score is wrong. Coverage already guarantees a
 * completed sync spanning the window that ran after it closed, so the score is
 * correct for the data we hold. It means only that we last looked a while ago,
 * and backdated or amended transactions may have arrived since — so a re-sync
 * could revise it. A consumer making a marginal decision may care; most will
 * not.
 */
export type Completeness = 'complete' | 'stale';

export interface DataQuality {
  completeness: Completeness;

  /**
   * The window the caller asked for, and the range we can actually vouch for.
   *
   * BOTH ends matter, and the start is the more dangerous one. If a sync only
   * ever fetched from 2026-01-01 and the caller asks for a window opening
   * 2025-09-01, the four unfetched months do not look empty-because-unfetched —
   * they look like four months with no income. Component A reads 2/6 instead of
   * 6/6 and the applicant is scored down for a gap that is ours, not theirs.
   *
   * That is the "missing data scoring as bad data" failure from
   * docs/scoring-model.md in its most severe form, because here the missing data
   * is our own fault rather than a limitation of what the bank can see.
   */
  window_start: string;
  window_end: string;
  /** Oldest date every account is confirmed to cover. Null if never fully synced. */
  covers_from: string | null;
  /**
   * Newest booking date actually stored for this user — what we HOLD, not what
   * we asked for. The two differ: a sync requests the provider's whole
   * published range, whose end can be in the future, so reporting the requested
   * end here would tell an auditor we hold data we do not have.
   */
  covers_through: string | null;
  /** Accounts fully spanning the window, over accounts known. Always equal once served. */
  accounts_covering: number;
  accounts_total: number;
  /** Age of the data backing this score. */
  last_sync_at: string | null;
  last_sync_status: string | null;
  /** Age of the merchant category dictionary used for essential/high-risk. */
  category_dictionary_age_hours: number | null;
  /**
   * Human-readable caveats, merged into the response `drivers` so an analyst
   * reading the explanation cannot miss them.
   */
  warnings: string[];
}

/**
 * How long since the backing sync before a served score is flagged `stale`.
 *
 * Measured from the sync, not from the window: a window that closed in February
 * is still worth re-checking in August, because amendments accrue with elapsed
 * time rather than with the window's position. Generous, because transactions
 * are backdated by days in normal banking operation and a tighter bound would
 * flag every score.
 */
export const STALE_AFTER_HOURS = 48;

// There is deliberately no coverage THRESHOLD constant. Coverage is binary:
// complete, or the request is refused. A threshold would be a number to argue
// about, and any value below 100% still returns an authoritative-looking score
// computed over a window it does not actually describe.

export class DataQualityService {
  /**
   * Reads `sync_runs`: when the last run finished, whether one is in flight,
   * and how many accounts it covered. Coverage itself is decided earlier, by
   * `coverage.ts`; by the time this runs the window is known to be covered.
   */
  async assess(
    /**
     * Supplied by the caller so this read joins the caller's MVCC snapshot.
     * Holding its own pool handle would put this query at a different instant
     * from the transaction read, reintroducing the read skew the snapshot
     * exists to prevent — and stateless collaborators are easier to test.
     */
    client: pg.PoolClient,
    userId: string,
    window: ScoringWindow,
    coverage: Coverage,
    categoryAgeHours: number | null,
    now: Date = new Date(),
  ): Promise<DataQuality> {
    const { rows } = await client.query<{
      status: string;
      started_at: string;
      finished_at: string | null;
    }>(
      `SELECT status, started_at::text, finished_at::text
         FROM sync_runs
        WHERE user_id = $1
        ORDER BY started_at DESC
        LIMIT 1`,
      [userId],
    );

    const last = rows[0];
    const lastSyncAt = last?.finished_at ?? last?.started_at ?? null;
    const ageHours =
      lastSyncAt === null ? null : (now.getTime() - Date.parse(lastSyncAt)) / 3_600_000;

    const warnings: string[] = [];
    // Not an error: coverage already guaranteed a completed sync spanning the
    // window that ran after it closed, so the score is correct for the data we
    // hold. Staleness only means a re-sync might revise it.
    const stale = ageHours !== null && ageHours > STALE_AFTER_HOURS;
    if (stale) {
      warnings.push(
        `Data last synced ${String(Math.round(ageHours))}h ago; backdated or amended ` +
          'transactions may have arrived since',
      );
    }
    if (coverage.observed_same_day) {
      warnings.push(
        `The window ends ${window.end}, and the sync covering it ran that same day — ` +
          'transactions booked later that day are not included',
      );
    }
    if (categoryAgeHours !== null && categoryAgeHours > 24 * 7) {
      warnings.push(
        `Merchant category dictionary is ${String(Math.round(categoryAgeHours / 24))} days old`,
      );
    }

    // On the caller's client, so it observes the same instant as every other
    // read feeding this score.
    const { rows: booked } = await client.query<{ newest: string | null }>(
      `SELECT max(booked_at)::text AS newest
         FROM transactions
        WHERE user_id = $1 AND status = 'active'`,
      [userId],
    );
    const newestBooked = booked[0]?.newest ?? null;

    return {
      completeness: stale ? 'stale' : 'complete',
      window_start: window.start,
      window_end: window.end,
      covers_from: coverage.covers_from,
      covers_through: newestBooked,
      accounts_total: coverage.accounts_total,
      accounts_covering: coverage.accounts_covering,
      last_sync_at: lastSyncAt,
      last_sync_status: last?.status ?? null,
      category_dictionary_age_hours:
        categoryAgeHours === null ? null : Math.round(categoryAgeHours),
      warnings,
    };
  }
}
