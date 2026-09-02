import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { assessCoverage, requireCompleteCoverage } from '../../src/modules/reliability/coverage.js';
import { SyncRequiredError } from '../../src/lib/errors.js';
import { testPool } from '../helpers/db.js';
import type { ScoringWindow } from '../../src/lib/date.js';

/**
 * The product rule: score only on data that completely covers the window.
 * Anything short — 99% included — is refused.
 *
 * Integration tier: coverage is a SQL question about two tables, and the
 * account/state LEFT JOIN is the part most likely to be wrong.
 */
const pool = testPool();
afterAll(() => pool.end());

const USER = 'user_coverage_test';
const WINDOW: ScoringWindow = {
  start: '2025-09-01',
  end: '2026-02-20',
  months: ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02'],
};

/**
 * `syncedAt` defaults to comfortably after the window end, because that is the
 * uninteresting case; the tests that care about it pass it explicitly.
 */
/**
 * Records a completed run that walked `accountIds` over `from`..`through`.
 *
 * `startedAt` defaults to comfortably after the window end, because that is the
 * uninteresting case; tests that care about the observation rule pass it.
 */
async function run(
  accountIds: string[],
  from: string | null,
  through: string | null,
  startedAt = '2026-06-01T00:00:00Z',
  status: 'succeeded' | 'partial' = 'succeeded',
  categoryVersion: number | null = 1,
) {
  await pool.query(
    `INSERT INTO sync_runs
       (id, user_id, status, synced_from, covers_through, covered_account_ids,
        started_at, category_version)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      `run_${String(Math.random()).slice(2)}`,
      USER,
      status,
      from,
      through,
      JSON.stringify(accountIds),
      startedAt,
      categoryVersion,
    ],
  );
}

async function account(id: string) {
  await pool.query(
    `INSERT INTO accounts (id, user_id, currency) VALUES ($1, $2, 'EUR')
     ON CONFLICT (id) DO NOTHING`,
    [id, USER],
  );
}

const coverage = async () => {
  const client = await pool.connect();
  try {
    return await assessCoverage(client, USER, WINDOW);
  } finally {
    client.release();
  }
};

beforeEach(async () => {
  await pool.query('DELETE FROM sync_runs WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM accounts WHERE user_id = $1', [USER]);
});

describe('assessCoverage', () => {
  it('is complete when every account spans the whole window', async () => {
    await account('a1');
    await run(['a1'], '2025-01-01', '2026-03-01');
    await account('a2');
    await run(['a2'], '2025-08-01', '2026-02-20');
    const c = await coverage();
    expect(c.complete).toBe(true);
    expect(c.gaps).toEqual([]);
    expect(c.accounts_covering).toBe(2);
  });

  it('accepts coverage that exactly meets both boundaries', async () => {
    await account('a1');
    await run(['a1'], '2025-09-01', '2026-02-20');
    expect((await coverage()).complete).toBe(true);
  });

  /** The rule with no threshold: one day short is short. */
  it('refuses when an account ends ONE DAY before the window end', async () => {
    await account('a1');
    await run(['a1'], '2025-09-01', '2026-02-19');
    const c = await coverage();
    expect(c.complete).toBe(false);
    expect(c.gaps[0]?.reason).toBe('ends_too_early');
  });

  it('refuses when an account starts ONE DAY after the window start', async () => {
    await account('a1');
    await run(['a1'], '2025-09-02', '2026-02-20');
    expect((await coverage()).gaps[0]?.reason).toBe('starts_too_late');
  });

  it('reports both_ends_short when the range is inside the window', async () => {
    await account('a1');
    await run(['a1'], '2025-10-01', '2026-01-01');
    expect((await coverage()).gaps[0]?.reason).toBe('both_ends_short');
  });

  /**
   * Coverage across accounts is the INTERSECTION. One account synced only from
   * January limits the whole user, however far back the others reach.
   */
  it('one short account makes the whole user incomplete', async () => {
    await account('a1');
    await run(['a1'], '2020-01-01', '2030-01-01');
    await account('a2');
    await run(['a2'], '2026-01-01', '2026-02-20');
    const c = await coverage();
    expect(c.complete).toBe(false);
    expect(c.accounts_covering).toBe(1);
    expect(c.accounts_total).toBe(2);
  });

  it('reports covers_from/through as the intersection, not the union', async () => {
    await account('a1');
    await run(['a1'], '2025-01-01', '2026-06-01');
    await account('a2');
    await run(['a2'], '2025-10-01', '2026-03-01');
    const c = await coverage();
    expect(c.covers_from).toBe('2025-10-01'); // the LATER start
    expect(c.covers_through).toBe('2026-03-01'); // the EARLIER end
  });

  /**
   * A newly connected account appears in no prior run, so it is absent from
   * every `covered_account_ids` — which is why the account list comes from
   * `accounts` rather than from a count on the run.
   */
  it('treats an account with no sync state as never_synced', async () => {
    await account('a1');
    await run(['a1'], '2025-01-01', '2026-03-01');
    await account('a_new');
    const c = await coverage();
    expect(c.complete).toBe(false);
    expect(c.gaps.map((g) => g.account_id)).toContain('a_new');
    expect(c.gaps.find((g) => g.account_id === 'a_new')?.reason).toBe('never_synced');
  });

  it('nulls the intersection when any account is unsynced', async () => {
    await account('a1');
    await run(['a1'], '2025-01-01', '2026-03-01');
    await account('a_new');
    const c = await coverage();
    expect(c.covers_from).toBeNull();
    expect(c.covers_through).toBeNull();
  });

  it('a user with no accounts is not covered', async () => {
    const c = await coverage();
    expect(c.complete).toBe(false);
    expect(c.accounts_total).toBe(0);
  });

  it('ignores other users’ accounts', async () => {
    await pool.query(
      `INSERT INTO accounts (id, user_id, currency) VALUES ('other_a', 'someone_else', 'EUR')
       ON CONFLICT (id) DO NOTHING`,
    );
    await account('a1');
    await run(['a1'], '2025-01-01', '2026-03-01');
    expect((await coverage()).accounts_total).toBe(1);
    await pool.query("DELETE FROM accounts WHERE user_id = 'someone_else'");
  });
});

/**
 * Coverage is about what the sync could have OBSERVED, not what it requested.
 *
 * `to` may legitimately be in the future — this provider publishes data through
 * 2027 — so a generous `covers_through` proves nothing on its own.
 */
describe('the sync must have run after the window closed', () => {
  it('refuses when the sync ran BEFORE the window end, however generous its `to`', async () => {
    // Asked for everything through 2027; actually ran in January.
    await account('a1');
    await run(['a1'], '2025-09-01', '2027-06-30', '2026-01-15T10:00:00Z');
    const c = await coverage();
    expect(c.complete).toBe(false);
    expect(c.gaps[0]?.reason).toBe('synced_before_window_end');
  });

  /**
   * A sync ON the window's last day counts. Requiring strictly after would make
   * a window ending today unscoreable on any day — the run would have to start
   * tomorrow — so the natural "sync, then score as of today" is impossible. The
   * cost is bounded to that one day, and is reported rather than hidden.
   */
  it('accepts a sync that ran ON the window end date', async () => {
    await account('a1');
    await run(['a1'], '2025-09-01', '2027-06-30', '2026-02-20T09:00:00Z');
    const c = await coverage();
    expect(c.complete).toBe(true);
    expect(c.observed_same_day).toBe(true);
  });

  it('does not flag same-day observation when the sync ran later', async () => {
    await account('a1');
    await run(['a1'], '2025-09-01', '2027-06-30', '2026-02-21T00:00:01Z');
    const c = await coverage();
    expect(c.complete).toBe(true);
    expect(c.observed_same_day).toBe(false);
  });

  it('still refuses a sync that ran BEFORE the window closed', async () => {
    await account('a1');
    await run(['a1'], '2025-09-01', '2027-06-30', '2026-02-19T23:59:59Z');
    expect((await coverage()).gaps[0]?.reason).toBe('synced_before_window_end');
  });

  it('accepts a sync that ran the day AFTER the window end', async () => {
    await account('a1');
    await run(['a1'], '2025-09-01', '2027-06-30', '2026-02-21T00:00:01Z');
    expect((await coverage()).complete).toBe(true);
  });

  it('an account never fully synced is never_synced, not synced_before_window_end', async () => {
    await account('a1');
    expect((await coverage()).gaps[0]?.reason).toBe('never_synced');
  });

  it('reports when the last complete sync ran, so the caller can see why', async () => {
    await account('a1');
    await run(['a1'], '2025-09-01', '2027-06-30', '2026-01-15T10:00:00Z');
    const gap = (await coverage()).gaps[0];
    expect(gap?.last_synced_at).toContain('2026-01-15');
  });

  it('one stale account spoils an otherwise covered user', async () => {
    await account('a1');
    await run(['a1'], '2025-01-01', '2026-03-01', '2026-03-02T00:00:00Z');
    await account('a2');
    await run(['a2'], '2025-01-01', '2027-06-30', '2026-01-15T00:00:00Z');
    const c = await coverage();
    expect(c.complete).toBe(false);
    expect(c.gaps.map((g) => g.account_id)).toEqual(['a2']);
  });
});

describe('requireCompleteCoverage', () => {
  it('passes silently on complete coverage', async () => {
    await account('a1');
    await run(['a1'], '2025-01-01', '2026-03-01');
    const c = await coverage();
    expect(() => {
      requireCompleteCoverage(c, WINDOW);
    }).not.toThrow();
  });

  it('throws SyncRequiredError on any gap', async () => {
    await account('a1');
    await run(['a1'], '2025-09-02', '2026-02-20');
    const c = await coverage();
    expect(() => {
      requireCompleteCoverage(c, WINDOW);
    }).toThrow(SyncRequiredError);
  });

  /** The remedy is mechanical, so the error must say exactly what is missing. */
  it('names the gap per account, the covered range, and the remedy', async () => {
    await account('a1');
    await run(['a1'], '2025-01-01', '2026-03-01');
    await account('a2');
    await run(['a2'], '2026-01-01', '2026-02-20');
    const c = await coverage();
    try {
      requireCompleteCoverage(c, WINDOW);
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as SyncRequiredError;
      expect(e.statusCode).toBe(409);
      expect(e.code).toBe('SYNC_REQUIRED');
      const d = e.details as Record<string, unknown>;
      expect(d['window']).toEqual({ start: WINDOW.start, end: WINDOW.end });
      expect(d['accounts_total']).toBe(2);
      expect(d['accounts_covering']).toBe(1);
      expect(d['remedy']).toContain('/sync');
      expect((d['gaps'] as { account_id: string }[])[0]?.account_id).toBe('a2');
    }
  });

  it('says so plainly when the user has no synced accounts', async () => {
    const c = await coverage();
    expect(() => {
      requireCompleteCoverage(c, WINDOW);
    }).toThrow(/No synced accounts/);
  });
});

/**
 * Scoring interprets category codes with the dictionary the covering run
 * pinned. "Covering" is the load-bearing word: coverage composes across runs, so
 * the newest run is often not the one that established it.
 */
describe('the pinned category version comes from a covering run', () => {
  it('takes it from the run that covers the window, not the newest run', async () => {
    await account('acc_1');
    // Older run: actually covers the window, dictionary v7.
    await run(['acc_1'], '2025-09-01', '2026-03-01', '2026-03-02T00:00:00Z', 'succeeded', 7);
    // Newer run: too narrow to cover anything, dictionary v9.
    await run(['acc_1'], '2026-02-01', '2026-02-10', '2026-06-01T00:00:00Z', 'succeeded', 9);

    const c = await coverage();
    expect(c.complete).toBe(true);
    expect(c.category_version).toBe(7);
  });

  it('is null when no covering run recorded one, so scoring can refuse', async () => {
    await account('acc_1');
    await run(['acc_1'], '2025-09-01', '2026-03-01', '2026-03-02T00:00:00Z', 'succeeded', null);
    const c = await coverage();
    expect(c.complete).toBe(true);
    expect(c.category_version).toBeNull();
  });

  it('ignores the version on a run that covers nothing relevant', async () => {
    await account('acc_1');
    await account('acc_2');
    // Covers only acc_1 — the user is not fully covered, so nothing is pinned.
    await run(['acc_1'], '2025-09-01', '2026-03-01', '2026-03-02T00:00:00Z', 'partial', 4);
    const c = await coverage();
    expect(c.complete).toBe(false);
    // A partial run still qualifies for the accounts it walked.
    expect(c.category_version).toBe(4);
  });
});
