import type pg from 'pg';
import type { ScoringWindow } from '../../lib/date.js';
import type { Coverage } from './coverage.js';

/** `stale` is not wrong: coverage is already guaranteed. We last looked a while ago. */
export type Completeness = 'complete' | 'stale';

export interface DataQuality {
  completeness: Completeness;

  /** The START is the dangerous end: an unfetched month looks like no income. */
  window_start: string;
  window_end: string;
  covers_from: string | null;
  /** What we HOLD, not what we asked for — a sync can request a future end date. */
  covers_through: string | null;
  accounts_covering: number;
  accounts_total: number;
  last_sync_at: string | null;
  last_sync_status: string | null;
  category_dictionary_age_hours: number | null;
  warnings: string[];
}

export const STALE_AFTER_HOURS = 48;

export class DataQualityService {
  async assess(
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
    if (coverage.category_version_is_fallback) {
      warnings.push(
        'The sync covering this window recorded no merchant category dictionary, so the ' +
          'current one was used instead — categories may have been regrouped since that sync',
      );
    }
    if (categoryAgeHours !== null && categoryAgeHours > 24 * 7) {
      warnings.push(
        `Merchant category dictionary is ${String(Math.round(categoryAgeHours / 24))} days old`,
      );
    }

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
