import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { BankingApiClient } from '../../src/banking/client.js';
import type { Database } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import { CategoryResolver } from '../../src/modules/reliability/categories.js';
import { AppError } from '../../src/lib/errors.js';
import { testPool } from '../helpers/db.js';

/**
 * Scoring interprets merchant category codes with the dictionary version the
 * covering sync recorded — not with whatever is newest, and never by asking
 * upstream.
 *
 * Two things follow, and both are the point:
 *  - a dictionary that is regrouped later cannot silently restate a score;
 *  - the scoring path makes no outbound call, so a credit decision does not
 *    inherit the Banking API's availability.
 */
const pool = testPool();
afterAll(() => pool.end());

const db: Database = drizzle(pool, { schema });

/** Any call to this fails the test: the scoring path must never reach upstream. */
const forbidden = new Proxy({} as BankingApiClient, {
  get(_t, prop) {
    throw new Error(`scoring reached the Banking API (.${String(prop)}) — it must not`);
  },
});

const seed = async (version: number, groceriesGroup: string) => {
  await pool.query(
    `INSERT INTO merchant_category_versions (version, content_hash, fetched_at)
     VALUES ($1, $2, now()) ON CONFLICT (version) DO NOTHING`,
    [version, `hash_v${String(version)}`],
  );
  const entries: [string, string][] = [
    ['5411', groceriesGroup],
    ['9001', 'income'],
    ['6012', 'fees'],
  ];
  for (const [code, grp] of entries) {
    await pool.query(
      `INSERT INTO merchant_categories (version, code, name, "group")
       VALUES ($1, $2, $3, $4) ON CONFLICT (version, code) DO NOTHING`,
      [version, code, `cat ${code}`, grp],
    );
  }
};

/**
 * Fixture versions far above anything a real refresh mints. Left behind, they
 * would push the next genuine dictionary to a higher number and quietly break
 * the "versions are never deleted" invariant for anything pinned to them.
 */
const clearFixtures = async () => {
  await pool.query('DELETE FROM merchant_categories WHERE version IN (900101, 900102)');
  await pool.query('DELETE FROM merchant_category_versions WHERE version IN (900101, 900102)');
};

beforeEach(clearFixtures);
afterAll(clearFixtures);

describe('categories are pinned to the sync, and resolved locally', () => {
  it('resolves the pinned version even when a newer one exists', async () => {
    await seed(900101, 'essential');
    await seed(900102, 'discretionary'); // groceries regrouped later
    const resolver = new CategoryResolver(db, forbidden);

    const pinned = await resolver.forVersion(900101);
    expect(pinned.version).toBe(900101);
    // Still essential under the version the score was synced against.
    expect(pinned.essential).toContain('5411');
  });

  it('reflects the regrouping only for a score pinned to the newer version', async () => {
    await seed(900101, 'essential');
    await seed(900102, 'discretionary');
    const resolver = new CategoryResolver(db, forbidden);
    expect((await resolver.forVersion(900102)).essential).not.toContain('5411');
  });

  it('never calls the Banking API', async () => {
    await seed(900101, 'essential');
    const resolver = new CategoryResolver(db, forbidden);
    // The proxy throws on any property access; completing proves none happened.
    await expect(resolver.forVersion(900101)).resolves.toBeDefined();
  });

  /** Versions are never deleted, so a missing one is a real integrity failure. */
  it('refuses a version that is not stored, rather than falling back to the newest', async () => {
    await seed(900101, 'essential');
    const resolver = new CategoryResolver(db, forbidden);
    await expect(resolver.forVersion(900102)).rejects.toBeInstanceOf(AppError);
    await expect(resolver.forVersion(900102)).rejects.toMatchObject({
      code: 'CATEGORIES_UNAVAILABLE',
      statusCode: 503,
    });
  });

  it('reads a version once and serves later calls from memory', async () => {
    await seed(900101, 'essential');
    const resolver = new CategoryResolver(db, forbidden);
    const first = await resolver.forVersion(900101);

    // Delete the rows out from under it. A second read would now throw; the
    // memo means it does not — proving the second call touched no database.
    await pool.query('DELETE FROM merchant_categories WHERE version = 900101');
    const second = await resolver.forVersion(900101);
    expect(second).toBe(first);
  });

  /**
   * `currentVersion()` reads the global maximum, and test files run in parallel
   * against one database — so asserting an exact number here asserts that no
   * other suite has seeded a higher fixture, which is not this test's business.
   * What matters is the ordering: a newly seeded version becomes the newest.
   */
  it('reports the newest local version, which is what a sync records', async () => {
    const resolver = new CategoryResolver(db, forbidden);
    await seed(900101, 'essential');
    const afterFirst = await resolver.currentVersion();
    expect(afterFirst).not.toBeNull();
    expect(afterFirst).toBeGreaterThanOrEqual(900101);

    await seed(900102, 'essential');
    const afterSecond = await resolver.currentVersion();
    expect(afterSecond).toBeGreaterThanOrEqual(900102);
    expect(afterSecond).toBeGreaterThanOrEqual(afterFirst ?? 0);
  });
});
