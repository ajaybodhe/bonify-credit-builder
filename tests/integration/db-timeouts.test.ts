import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/db/client.js';
import { ConflictError } from '../../src/lib/errors.js';
import { SYNC_RECLAIM_AFTER_MS, withSyncRun } from '../../src/modules/sync/claim.js';
import { testPool } from '../helpers/db.js';

/**
 * Integration tier: these are assertions about how POSTGRES behaves under our
 * settings. A mock would only prove the mock times out.
 */
const url = process.env['DATABASE_URL'] ?? '';
const envFor = (max = 4) => ({ DATABASE_URL: url, DATABASE_POOL_MAX: max }) as never;

const pool = testPool();
afterAll(() => pool.end());

const settings = async (client: pg.Pool) =>
  Object.fromEntries(
    (
      await client.query<{ name: string; setting: string }>(
        `SELECT name, setting FROM pg_settings
          WHERE name IN ('statement_timeout','lock_timeout',
                         'idle_in_transaction_session_timeout')`,
      )
    ).rows.map((r) => [r.name, r.setting]),
  );

describe('connection timeouts', () => {
  /**
   * `connectionTimeoutMillis` bounds ACQUIRING a connection, not using one.
   * Without these three server-side settings a query that never returns holds
   * its connection forever, and the pool drains one stuck request at a time.
   */
  it('applies statement, lock and idle-in-transaction timeouts to every connection', async () => {
    const { pool: p, close } = createDatabase(envFor());
    try {
      expect(await settings(p)).toEqual({
        statement_timeout: '15000',
        lock_timeout: '5000',
        idle_in_transaction_session_timeout: '30000',
      });
    } finally {
      await close();
    }
  });

  it('aborts a statement that outlives the budget, rather than hanging', async () => {
    // 300ms rather than the production 15s: this asserts the mechanism, and a
    // test that sleeps 15s to prove it would not get run.
    const { pool: p, close } = createDatabase(envFor(), { statementTimeoutMs: 300 });
    try {
      const startedAt = Date.now();
      await expect(p.query('SELECT pg_sleep(5)')).rejects.toThrow(/statement timeout/);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      await close();
    }
  });

  it('releases the connection back to the pool after a timeout', async () => {
    // Otherwise the first slow query would permanently cost one slot, and the
    // timeout would trade a hung request for a dead pool.
    const { pool: p, close } = createDatabase(envFor(1), { statementTimeoutMs: 300 });
    try {
      await expect(p.query('SELECT pg_sleep(5)')).rejects.toThrow(/statement timeout/);
      const { rows } = await p.query<{ ok: number }>('SELECT 1 AS ok');
      expect(rows[0]?.ok).toBe(1);
    } finally {
      await close();
    }
  });

  /**
   * An index build on a large table is the one statement that is legitimately
   * long. Killing it halfway is worse than waiting, so `db:migrate` opts out.
   */
  it('lets migrations opt out of the statement timeout entirely', async () => {
    const { pool: p, close } = createDatabase(envFor(), { statementTimeoutMs: 0 });
    try {
      expect((await settings(p))['statement_timeout']).toBe('0');
      // 0 means no limit, not "time out immediately".
      await expect(p.query('SELECT pg_sleep(0.5)')).resolves.toBeDefined();
    } finally {
      await close();
    }
  });
});

describe('a claim that loses on lock_timeout is still a 409', () => {
  const USER = 'user_lock_timeout';

  /**
   * Two ways to lose the claim, and they raise different SQLSTATEs. Normally
   * the winner has already committed, so the loser gets `23505`. If the winner
   * is still in flight the loser waits on the uncommitted index key instead,
   * and `lock_timeout` fires with `55P03`. Both mean "someone else holds this
   * user's slot" — a 409. Only mapping `23505` would turn the second into a
   * 500, and it is the one that shows up under load.
   */
  it('maps 55P03 to ConflictError, not to a 500', async () => {
    await pool.query('DELETE FROM sync_runs WHERE user_id = $1', [USER]);

    // A short lock_timeout keeps the test fast; production waits 5s.
    const impatient = new pg.Pool({
      connectionString: url,
      max: 2,
      options: '-c lock_timeout=200',
    });
    // The winner: holds an uncommitted running row, so its index key is taken
    // but invisible.
    const winner = await pool.connect();
    try {
      await winner.query('BEGIN');
      await winner.query(
        `INSERT INTO sync_runs (id, user_id, status, started_at)
         VALUES ('run_lock_winner', $1, 'running', now())`,
        [USER],
      );

      await expect(
        withSyncRun(impatient, USER, 'api', () => Promise.resolve('should not run')),
      ).rejects.toBeInstanceOf(ConflictError);
    } finally {
      await winner.query('ROLLBACK').catch(() => undefined);
      winner.release();
      await impatient.end();
      await pool.query('DELETE FROM sync_runs WHERE user_id = $1', [USER]);
    }
  });
});

/**
 * Why reclamation survives the arrival of connection timeouts.
 *
 * They look like they overlap, and they do not: the timeouts bound SESSIONS and
 * STATEMENTS, while a wedged claim is COMMITTED DATA. Nothing Postgres can time
 * out will clear a committed row.
 */
describe('connection timeouts cannot replace reclamation', () => {
  const USER = 'user_wedge_test';
  const running = async () =>
    (await pool.query("SELECT 1 FROM sync_runs WHERE user_id = $1 AND status = 'running'", [USER]))
      .rowCount ?? 0;

  it('a committed running row outlives the death of the connection that wrote it', async () => {
    await pool.query('DELETE FROM sync_runs WHERE user_id = $1', [USER]);

    // A process that claimed, committed, and then died.
    const doomed = new pg.Pool({ connectionString: url, max: 1 });
    await doomed.query(
      `INSERT INTO sync_runs (id, user_id, status, started_at)
       VALUES ('run_wedged', $1, 'running', now() - interval '2 hours')`,
      [USER],
    );
    await doomed.end(); // every session timeout is now moot: there is no session

    // idle_in_transaction_session_timeout has nothing to reap — the claim
    // transaction committed by design, so no transaction was left open.
    // statement_timeout has nothing to kill — the sync issues many short
    // statements, never one long one.
    expect(await running()).toBe(1);

    // Only reclamation clears it, and only because started_at went stale.
    await expect(withSyncRun(pool, USER, 'api', () => Promise.resolve('ok'))).resolves.toBe('ok');
    const { rows } = await pool.query<{ status: string }>(
      "SELECT status FROM sync_runs WHERE id = 'run_wedged'",
    );
    expect(rows[0]?.status).toBe('abandoned');
    await pool.query('DELETE FROM sync_runs WHERE user_id = $1', [USER]);
  });

  it('the reclaim window sits far above the statement budget', () => {
    // If a single statement could approach it, statement_timeout would fire
    // first and reclamation would be redundant.
    expect(SYNC_RECLAIM_AFTER_MS).toBeGreaterThan(15_000 * 2);
  });
});
