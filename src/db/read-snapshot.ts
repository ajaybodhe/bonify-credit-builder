import type pg from 'pg';

/**
 * Runs `fn` inside a REPEATABLE READ, READ ONLY transaction.
 *
 * Scoring reads several things — transactions in the window, account balances,
 * sync state, the category dictionary. Issued as separate autocommit queries,
 * a sync committing between any two of them would produce a score computed
 * from a combination of states that never simultaneously existed: a
 * transaction list from 10:00:01 against a balance from 10:00:02.
 *
 * That is *read skew*, and it is nastier than it sounds here, because the
 * result is not an error. It is a plausible score, stored in the audit trail,
 * with an `input_hash` that describes a state the database was never in — so
 * the reproducibility guarantee quietly stops holding.
 *
 * REPEATABLE READ pins one MVCC snapshot for the whole transaction, so every
 * read sees the same instant. Postgres gives this essentially for free on a
 * read-only workload: no locks are taken, concurrent writers are not blocked,
 * and readers never block writers.
 *
 * READ ONLY is declared deliberately: it makes the database reject a write
 * from inside the scoring read path, rather than relying on us to remember.
 * The snapshot INSERT happens afterwards, outside this transaction, precisely
 * so the read stays provably free of side effects.
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
      // Best-effort: if the connection is already broken the ROLLBACK will
      // fail too, and the original error is the one worth propagating.
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    client.release();
  }
}
