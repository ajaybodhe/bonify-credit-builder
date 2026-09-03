import pg from 'pg';

/** A pool pointed at the integration/e2e database. Caller owns shutdown. */
export function testPool(): pg.Pool {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL must be set for integration tests');
  return new pg.Pool({ connectionString, max: 8 });
}

/**
 * Leaves the merchant category dictionary exactly as the suite found it.
 *
 * Tests and dev data share one database, and `currentVersion()` reads the global
 * maximum. A suite that syncs through a fake mints a version from the fake's
 * categories, so the next real score is pinned to a dictionary that came from a
 * test — the number moves and nothing explains why. Call in `beforeAll`, and the
 * returned function in `afterAll`.
 */
export async function isolateDictionary(pool: pg.Pool): Promise<() => Promise<void>> {
  const { rows } = await pool.query<{ max: number | null }>(
    'SELECT max(version) AS max FROM merchant_category_versions',
  );
  const highWater = rows[0]?.max ?? 0;

  return async () => {
    // Snapshots first: they pin a version, and a snapshot pointing at a
    // dictionary we are about to delete is unexplainable by construction.
    await pool.query('DELETE FROM score_snapshots WHERE category_version > $1', [highWater]);
    await pool.query('DELETE FROM merchant_categories WHERE version > $1', [highWater]);
    await pool.query('DELETE FROM merchant_category_versions WHERE version > $1', [highWater]);
  };
}

/** Deferred promise, for pinning one task open while another races it. */
export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
