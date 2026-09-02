import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { BankingApiClient } from '../../src/banking/client.js';
import type { Database } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import { AppError, SyncRequiredError } from '../../src/lib/errors.js';
import { CategoryResolver } from '../../src/modules/reliability/categories.js';
import { DataQualityService } from '../../src/modules/reliability/data-quality.js';
import { ReliabilityService } from '../../src/modules/reliability/service.js';
import { testPool } from '../helpers/db.js';

/**
 * The scoring orchestration, driven directly: coverage gate → category pinning
 * → model → snapshot → response.
 *
 * The e2e suite covers the happy path through HTTP. What it cannot reach are
 * the refusals, because they need a database state no sequence of API calls
 * produces — a run that covered the window but recorded no dictionary, or
 * coverage that composes across runs.
 */
const pool = testPool();
afterAll(async () => {
  await pool.query('DELETE FROM merchant_categories WHERE version = $1', [V]);
  await pool.query('DELETE FROM merchant_category_versions WHERE version = $1', [V]);
  await pool.end();
});

const db: Database = drizzle(pool, { schema });
const USER = 'user_orchestration';
const ACCOUNT = 'acc_orch';
const FROM = '2026-02-20';
/** Deliberately BELOW other suites' fixture versions: files run in parallel
 * against one database, and `currentVersion()` reads the global maximum. */
const V = 890501;

/** Any call fails the test: scoring must never reach upstream. */
const forbidden = new Proxy({} as BankingApiClient, {
  get(_t, prop) {
    throw new Error(`scoring reached the Banking API (.${String(prop)})`);
  },
});

const service = () =>
  new ReliabilityService(db, pool, new CategoryResolver(db, forbidden), new DataQualityService());

async function seedDictionary(version: number) {
  await pool.query(
    `INSERT INTO merchant_category_versions (version, content_hash, fetched_at)
     VALUES ($1, $2, now()) ON CONFLICT (version) DO NOTHING`,
    [version, `h${String(version)}`],
  );
  for (const [code, group] of [
    ['9001', 'income'],
    ['5411', 'essential'],
    ['6012', 'fees'],
  ]) {
    await pool.query(
      `INSERT INTO merchant_categories (version, code, name, "group")
       VALUES ($1, $2, $3, $4) ON CONFLICT (version, code) DO NOTHING`,
      [version, code, code, group],
    );
  }
}

async function seedRun(categoryVersion: number | null, accounts = [ACCOUNT]) {
  await pool.query(
    `INSERT INTO sync_runs (id, user_id, status, synced_from, covers_through,
                            covered_account_ids, started_at, category_version)
     VALUES ($1, $2, 'succeeded', '2025-09-01', '2027-06-30', $3::jsonb,
             now(), $4)`,
    [`run_${String(Math.random()).slice(2)}`, USER, JSON.stringify(accounts), categoryVersion],
  );
}

async function seedTransactions() {
  await pool.query(
    `INSERT INTO accounts (id, user_id, currency, type, current_balance)
     VALUES ($1, $2, 'EUR', 'checking', '1500.00') ON CONFLICT (id) DO NOTHING`,
    [ACCOUNT, USER],
  );
  for (const [i, month] of [
    '2025-09',
    '2025-10',
    '2025-11',
    '2025-12',
    '2026-01',
    '2026-02',
  ].entries()) {
    await pool.query(
      `INSERT INTO transactions (id, account_id, user_id, booked_at, amount, currency,
                                 category, is_credit, status, content_hash, revision)
       VALUES ($1,$2,$3,$4,$5,'EUR',$6,$7,'active',$8,1)`,
      [
        `o_in_${String(i)}`,
        ACCOUNT,
        USER,
        `${month}-01`,
        '2000.00',
        '9001',
        true,
        `hi${String(i)}`,
      ],
    );
    await pool.query(
      `INSERT INTO transactions (id, account_id, user_id, booked_at, amount, currency,
                                 category, is_credit, status, content_hash, revision)
       VALUES ($1,$2,$3,$4,$5,'EUR',$6,$7,'active',$8,1)`,
      [
        `o_out_${String(i)}`,
        ACCOUNT,
        USER,
        `${month}-05`,
        '-800.00',
        '5411',
        false,
        `ho${String(i)}`,
      ],
    );
  }
}

beforeEach(async () => {
  await pool.query('DELETE FROM score_snapshots WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM transactions WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM accounts WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM sync_runs WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM merchant_categories WHERE version = $1', [V]);
  await pool.query('DELETE FROM merchant_category_versions WHERE version = $1', [V]);
});

describe('the coverage gate runs before anything is loaded', () => {
  it('refuses a user with no synced accounts', async () => {
    await expect(service().getReliability(USER, FROM)).rejects.toBeInstanceOf(SyncRequiredError);
  });

  it('refuses when one account of two is uncovered, naming the gap', async () => {
    await seedDictionary(V);
    await seedTransactions();
    await pool.query(
      `INSERT INTO accounts (id, user_id, currency, type) VALUES ('acc_orch_2', $1, 'EUR', 'checking')
       ON CONFLICT (id) DO NOTHING`,
      [USER],
    );
    await seedRun(V, [ACCOUNT]); // covers only the first account

    await expect(service().getReliability(USER, FROM)).rejects.toMatchObject({
      code: 'SYNC_REQUIRED',
    });
  });

  it('writes no snapshot when it refuses', async () => {
    await expect(service().getReliability(USER, FROM)).rejects.toThrow();
    const { rows } = await pool.query<{ c: string }>(
      'SELECT count(*)::text AS c FROM score_snapshots WHERE user_id = $1',
      [USER],
    );
    expect(rows[0]?.c).toBe('0');
  });
});

describe('category pinning decides whether a score can be served', () => {
  /**
   * A covering run that recorded no dictionary cannot be scored: the essential
   * list is unknown, so component C is undefined. This is decided from LOCAL
   * state — the forbidden client proves no upstream call is attempted.
   */
  it('refuses with CATEGORIES_UNAVAILABLE when the covering run pinned none', async () => {
    await seedTransactions();
    await seedRun(null);
    await expect(service().getReliability(USER, FROM)).rejects.toMatchObject({
      code: 'CATEGORIES_UNAVAILABLE',
      statusCode: 503,
    });
  });

  it('refuses when the pinned version is not stored, rather than falling back', async () => {
    await seedTransactions();
    await seedRun(V); // version recorded, but its rows were never written
    await expect(service().getReliability(USER, FROM)).rejects.toBeInstanceOf(AppError);
  });
});

describe('a served score, end to end through the service', () => {
  beforeEach(async () => {
    await seedDictionary(V);
    await seedTransactions();
    await seedRun(V);
  });

  it('scores, explains, and records the versions it used', async () => {
    const res = await service().getReliability(USER, FROM);
    expect(res.reliability_index).toBeGreaterThan(0);
    expect(res.drivers.length).toBeGreaterThan(0);
    expect(res.model_version).toBe(1);
    // A just-synced run is complete; age is what would make it `stale`.
    expect(res.data_quality.completeness).toBe('complete');
    expect(res.data_quality.accounts_covering).toBe(res.data_quality.accounts_total);
  });

  it('persists exactly one snapshot, pinned to the covering run’s dictionary', async () => {
    const res = await service().getReliability(USER, FROM);
    const { rows } = await pool.query<{
      reliability_index: number;
      category_version: number;
      closing_balances: Record<string, string> | null;
    }>(
      `SELECT reliability_index, category_version, closing_balances
         FROM score_snapshots WHERE user_id = $1`,
      [USER],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reliability_index).toBe(res.reliability_index);
    expect(rows[0]?.category_version).toBe(V);
    expect(rows[0]?.closing_balances?.[ACCOUNT]).toBe('1500.00');
  });

  it('is idempotent: scoring twice yields the same number and one row', async () => {
    const first = await service().getReliability(USER, FROM);
    const second = await service().getReliability(USER, FROM);
    expect(second.reliability_index).toBe(first.reliability_index);
    const { rows } = await pool.query<{ c: string }>(
      'SELECT count(*)::text AS c FROM score_snapshots WHERE user_id = $1',
      [USER],
    );
    expect(rows[0]?.c).toBe('1');
  });
});
