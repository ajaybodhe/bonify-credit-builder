import type pg from 'pg';

/**
 * REPEATABLE READ, READ ONLY. As separate autocommit queries, a sync committing
 * between any two yields a plausible score whose `input_hash` describes a state
 * the database was never in.
 */
export async function withReadSnapshot<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    client.release();
  }
}
