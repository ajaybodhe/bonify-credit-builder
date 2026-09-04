import pg from 'pg';

/**
 * A pool pointed at the TEST database. Caller owns shutdown.
 *
 * These suites write real rows through the real service — a sync opens its own
 * transactions on its own pool, so a test cannot wrap them in one and roll back.
 * Isolation therefore has to come from the database, not the transaction.
 *
 * That matters more than it sounds. Transaction ids are the primary key and are
 * not scoped by user, and the fake and the live provider both mint `txn_00001`
 * shapes, so an e2e sync pointed at a database holding real data upserts
 * straight over it. That is not hypothetical: it silently ate 33 of
 * `user_1001`'s transactions and moved its score from 62 to 48.
 *
 * `TEST_DATABASE_URL` keeps the two apart. CI already runs against a dedicated
 * Postgres service, so it needs no second variable and falls back cleanly.
 */
export function testDatabaseUrl(): string {
  const connectionString = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('Set TEST_DATABASE_URL (or DATABASE_URL in CI) to run these tests');
  }
  return connectionString;
}

export function testPool(): pg.Pool {
  return new pg.Pool({ connectionString: testDatabaseUrl(), max: 8 });
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
