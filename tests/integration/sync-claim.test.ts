import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { finishRun, SYNC_RECLAIM_AFTER_MS, withSyncRun } from '../../src/modules/sync/claim.js';
import { ConflictError } from '../../src/lib/errors.js';
import { deferred, testPool } from '../helpers/db.js';

/**
 * One sync per user, enforced by the partial unique index on `sync_runs`
 * rather than by a lock (docs/architecture-design.md §4.5).
 *
 * Integration tier: the guarantee is a *database* one. Mocking it would only
 * prove the mock is mutually exclusive, when the whole point is that Postgres
 * arbitrates between competing transactions.
 */
const pool = testPool();
afterAll(() => pool.end());

const USER = 'user_claim_test';
const runningCount = async () =>
  Number(
    (
      await pool.query<{ c: string }>(
        "SELECT count(*)::text AS c FROM sync_runs WHERE user_id = $1 AND status = 'running'",
        [USER],
      )
    ).rows[0]?.c ?? '0',
  );

beforeEach(() =>
  pool.query('DELETE FROM sync_runs WHERE user_id = $1', [USER]).then(() => undefined),
);

describe('withSyncRun', () => {
  it('lets a single caller through and gives it a run id', async () => {
    const id = await withSyncRun(pool, USER, 'api', (run) => Promise.resolve(run.runId));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  /**
   * The race. The winner is pinned open so the competitor is guaranteed to
   * arrive mid-flight — no timing luck.
   */
  it('rejects a second concurrent sync with a 409', async () => {
    const held = deferred();
    const first = withSyncRun(pool, USER, 'api', async () => {
      await held.promise;
      return 'first';
    });
    await new Promise((r) => setTimeout(r, 30));

    await expect(
      withSyncRun(pool, USER, 'api', () => Promise.resolve('second')),
    ).rejects.toBeInstanceOf(ConflictError);

    held.resolve();
    await expect(first).resolves.toBe('first');
  });

  /**
   * The property the constraint approach must not lose: a loser fails FAST.
   * If the run row were inserted inside a transaction held open for the sync,
   * the competitor's INSERT would block on the uncommitted row instead.
   */
  it('a loser fails in milliseconds, not after the winner finishes', async () => {
    const held = deferred();
    const first = withSyncRun(pool, USER, 'api', async () => {
      await held.promise;
      return 'first';
    });
    await new Promise((r) => setTimeout(r, 30));

    const started = Date.now();
    await expect(withSyncRun(pool, USER, 'api', () => Promise.resolve('x'))).rejects.toThrow();
    const elapsed = Date.now() - started;

    // The winner is still running; the loser must not have waited for it.
    expect(elapsed).toBeLessThan(500);
    held.resolve();
    await first;
  });

  it('serialises many simultaneous attempts to exactly one winner', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        withSyncRun(pool, USER, 'api', async (run) => {
          await new Promise((r) => setTimeout(r, 40));
          return `${run.runId}:${String(i)}`;
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // The winner has since auto-finalised, so nothing is left running; exactly
    // one run row exists, and it is the one that succeeded.
    expect(await runningCount()).toBe(0);
    const rows = await pool.query<{ status: string }>(
      'SELECT status FROM sync_runs WHERE user_id = $1',
      [USER],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.status).toBe('succeeded');
  });

  it('does not make different users contend', async () => {
    const held = deferred();
    const a = withSyncRun(pool, `${USER}_a`, 'api', async () => {
      await held.promise;
      return 'a';
    });
    await new Promise((r) => setTimeout(r, 30));
    await expect(withSyncRun(pool, `${USER}_b`, 'api', () => Promise.resolve('b'))).resolves.toBe(
      'b',
    );
    held.resolve();
    await a;
    await pool.query('DELETE FROM sync_runs WHERE user_id = ANY($1)', [[`${USER}_a`, `${USER}_b`]]);
  });

  /**
   * A sync that throws must not wedge the user. This is the failure that would
   * otherwise need the reclaim timeout to clear — 120 seconds of lockout for
   * one upstream 500.
   */
  it('marks the run failed and frees the slot when the callback throws', async () => {
    await expect(
      withSyncRun(pool, USER, 'api', () => Promise.reject(new Error('upstream exploded'))),
    ).rejects.toThrow('upstream exploded');

    expect(await runningCount()).toBe(0);
    const row = await pool.query<{ status: string; error: string }>(
      'SELECT status, error FROM sync_runs WHERE user_id = $1',
      [USER],
    );
    expect(row.rows[0]?.status).toBe('failed');
    expect(row.rows[0]?.error).toContain('upstream exploded');

    await expect(withSyncRun(pool, USER, 'api', () => Promise.resolve('recovered'))).resolves.toBe(
      'recovered',
    );
  });

  it('does not exhaust the pool across many sequential syncs', async () => {
    // More iterations than the pool has connections: nothing may be pinned.
    for (let i = 0; i < 12; i++) {
      await withSyncRun(pool, USER, 'api', () => Promise.resolve(i));
      await pool.query('DELETE FROM sync_runs WHERE user_id = $1', [USER]);
    }
  });

  /** Nothing that returns normally may leave a `running` row for the reclaimer. */
  it('finalises as succeeded when the callback does not finish explicitly', async () => {
    await withSyncRun(pool, USER, 'api', () => Promise.resolve());
    expect(await runningCount()).toBe(0);
    const row = await pool.query<{ status: string }>(
      'SELECT status FROM sync_runs WHERE user_id = $1',
      [USER],
    );
    expect(row.rows[0]?.status).toBe('succeeded');
  });

  it('respects an explicit finish() over the default', async () => {
    await withSyncRun(pool, USER, 'api', (run) => run.finish('partial', { accountsFailed: 2 }));
    const row = await pool.query<{ status: string; accounts_failed: number }>(
      'SELECT status, accounts_failed FROM sync_runs WHERE user_id = $1',
      [USER],
    );
    expect(row.rows[0]?.status).toBe('partial');
    expect(row.rows[0]?.accounts_failed).toBe(2);
  });

  it('a throw after an explicit finish() does not rewrite the recorded status', async () => {
    await expect(
      withSyncRun(pool, USER, 'api', async (run) => {
        await run.finish('partial');
        throw new Error('late failure');
      }),
    ).rejects.toThrow('late failure');
    const row = await pool.query<{ status: string }>(
      'SELECT status FROM sync_runs WHERE user_id = $1',
      [USER],
    );
    expect(row.rows[0]?.status).toBe('partial');
  });

  it('records the trigger that started the run', async () => {
    await withSyncRun(pool, USER, 'scheduled', () => Promise.resolve());
    const row = await pool.query<{ trigger: string }>(
      'SELECT trigger FROM sync_runs WHERE user_id = $1',
      [USER],
    );
    expect(row.rows[0]?.trigger).toBe('scheduled');
  });
});

/**
 * Crash recovery. A dead process leaves a `running` row; without reclamation
 * the unique index refuses that user's syncs forever — one crash becoming a
 * permanent outage, which is worse than the race the index prevents.
 *
 * Staleness is measured from `started_at`, not from a heartbeat, because the
 * run enforces the same deadline on ITSELF. A live run always aborts before the
 * reclaim window opens, so a reclaimable row belongs to an owner that is gone.
 */
describe('stale run reclamation', () => {
  const insertRun = (ageSeconds: number) =>
    pool.query(
      `INSERT INTO sync_runs (id, user_id, status, started_at)
       VALUES ('run_stale', $1, 'running', now() - make_interval(secs => $2))`,
      [USER, ageSeconds],
    );

  it('reclaims a run that outlived the deadline and its grace period', async () => {
    await insertRun(SYNC_RECLAIM_AFTER_MS / 1000 + 60);
    await expect(withSyncRun(pool, USER, 'api', () => Promise.resolve('ok'))).resolves.toBe('ok');
    const stale = await pool.query<{ status: string; error: string | null }>(
      "SELECT status, error FROM sync_runs WHERE id = 'run_stale'",
    );
    expect(stale.rows[0]?.status).toBe('abandoned');
    expect(stale.rows[0]?.error).toMatch(/deadline/);
  });

  it('leaves a young run alone — it still owns the slot', async () => {
    await insertRun(1);
    await expect(withSyncRun(pool, USER, 'api', () => Promise.resolve())).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  /**
   * The grace period. A run at its own deadline is in the act of aborting and
   * writing its terminal status; reclaiming it at that moment would race that
   * write for no benefit.
   */
  it('does not reclaim a run past its deadline but still inside the grace period', async () => {
    await insertRun(SYNC_RECLAIM_AFTER_MS / 1000 - 30);
    await expect(withSyncRun(pool, USER, 'api', () => Promise.resolve())).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('leaves other users’ running rows alone', async () => {
    await pool.query(
      `INSERT INTO sync_runs (id, user_id, status, started_at)
       VALUES ('run_theirs', 'someone_else', 'running', now() - interval '1 hour')`,
    );
    await withSyncRun(pool, USER, 'api', () => Promise.resolve());
    const theirs = await pool.query<{ status: string }>(
      "SELECT status FROM sync_runs WHERE id = 'run_theirs'",
    );
    expect(theirs.rows[0]?.status).toBe('running');
    await pool.query("DELETE FROM sync_runs WHERE user_id = 'someone_else'");
  });

  /** A reclaimed run cannot resurrect itself: finish() only moves a running row. */
  it('a reclaimed run cannot overwrite the terminal status it was given', async () => {
    await pool.query(
      `INSERT INTO sync_runs (id, user_id, status, started_at)
       VALUES ('run_zombie', $1, 'abandoned', now())`,
      [USER],
    );
    await finishRun(pool, 'run_zombie', 'succeeded', {});
    const row = await pool.query<{ status: string }>(
      "SELECT status FROM sync_runs WHERE id = 'run_zombie'",
    );
    expect(row.rows[0]?.status).toBe('abandoned');
  });
});

/**
 * Why the partial unique index is load-bearing rather than decoration.
 *
 * The intuition that a single `INSERT ... WHERE NOT EXISTS` statement is
 * inherently atomic is wrong, and these tests exist so nobody "simplifies" the
 * index away on the strength of it. Run against a scratch table so the real
 * schema is never altered.
 */
describe('the unique index is what makes the claim atomic', () => {
  const INSERT_IF_NOT_EXISTS = `
    INSERT INTO claim_probe (id, user_id, status)
    SELECT $1, $2, 'running'
     WHERE NOT EXISTS (SELECT 1 FROM claim_probe WHERE user_id = $2 AND status = 'running')`;

  const runningRows = async () =>
    Number(
      (
        await pool.query<{ c: string }>(
          "SELECT count(*)::text AS c FROM claim_probe WHERE user_id = 'u' AND status = 'running'",
        )
      ).rows[0]?.c ?? '0',
    );

  beforeEach(async () => {
    await pool.query('DROP TABLE IF EXISTS claim_probe');
    await pool.query(
      'CREATE TABLE claim_probe (id text PRIMARY KEY, user_id text NOT NULL, status text NOT NULL)',
    );
  });

  afterAll(() => pool.query('DROP TABLE IF EXISTS claim_probe').then(() => undefined));

  /**
   * WITHOUT the index: `WHERE NOT EXISTS` reads the transaction's MVCC
   * snapshot, which cannot see a concurrent uncommitted row. Both claimants
   * find nothing in flight; both insert.
   */
  it('WITHOUT the index, two concurrent claimants both succeed — the race survives', async () => {
    const t1 = await pool.connect();
    const t2 = await pool.connect();
    try {
      await t1.query('BEGIN');
      await t2.query('BEGIN');
      expect((await t1.query(INSERT_IF_NOT_EXISTS, ['a', 'u'])).rowCount).toBe(1);
      // T2 cannot see T1's uncommitted row, so its NOT EXISTS is still true.
      expect((await t2.query(INSERT_IF_NOT_EXISTS, ['b', 'u'])).rowCount).toBe(1);
      await t1.query('COMMIT');
      await t2.query('COMMIT');
    } finally {
      t1.release();
      t2.release();
    }
    expect(await runningRows()).toBe(2); // two syncs would have run
  });

  /**
   * WITH the index: enforcement happens in the index structure, not against a
   * snapshot, so T2 blocks on the physical key and then fails with 23505.
   */
  it('WITH the index, the second claimant blocks and then fails 23505', async () => {
    await pool.query(
      "CREATE UNIQUE INDEX cp_one_running ON claim_probe (user_id) WHERE status = 'running'",
    );
    const t1 = await pool.connect();
    const t2 = await pool.connect();
    try {
      await t1.query('BEGIN');
      await t2.query('BEGIN');
      await t1.query(INSERT_IF_NOT_EXISTS, ['a', 'u']);

      const contender = t2.query(INSERT_IF_NOT_EXISTS, ['b', 'u']);
      const outcome = await Promise.race([
        contender.then(() => 'returned').catch(() => 'rejected'),
        new Promise((r) =>
          setTimeout(() => {
            r('blocked');
          }, 250),
        ),
      ]);
      // It must WAIT rather than sail through — this is the whole mechanism,
      // and it is why the claim transaction must commit quickly.
      expect(outcome).toBe('blocked');

      await t1.query('COMMIT');
      await expect(contender).rejects.toMatchObject({ code: '23505' });
      await t2.query('ROLLBACK');
    } finally {
      t1.release();
      t2.release();
    }
    expect(await runningRows()).toBe(1);
  });

  /** ON CONFLICT is not an alternative: it requires the index it would replace. */
  it('ON CONFLICT cannot substitute for the index — it requires one', async () => {
    await expect(
      pool.query(
        `INSERT INTO claim_probe (id, user_id, status) VALUES ('c', 'u', 'running')
         ON CONFLICT (user_id) WHERE status = 'running' DO NOTHING`,
      ),
    ).rejects.toThrow(/no unique or exclusion constraint/i);
  });
});

describe('finishRun', () => {
  it('drives a running row to a terminal status with totals', async () => {
    // Finalise from inside the run: once withSyncRun returns, the row is no
    // longer `running`, and finishRun is deliberately a no-op on it.
    const id = await withSyncRun(pool, USER, 'api', async (run) => {
      await run.finish('partial', { newTransactions: 168, accountsFailed: 1 });
      return run.runId;
    });
    const row = await pool.query<{
      status: string;
      new_transactions: number;
      accounts_failed: number;
    }>('SELECT status, new_transactions, accounts_failed FROM sync_runs WHERE id = $1', [id]);
    expect(row.rows[0]?.status).toBe('partial');
    expect(row.rows[0]?.new_transactions).toBe(168);
    expect(row.rows[0]?.accounts_failed).toBe(1);
  });

  it('only affects a running row, so a second call is a no-op', async () => {
    // withSyncRun already finalised this to `succeeded`.
    const id = await withSyncRun(pool, USER, 'api', (run) => Promise.resolve(run.runId));
    await finishRun(pool, id, 'failed', { error: 'should not overwrite' });
    const row = await pool.query<{ status: string }>('SELECT status FROM sync_runs WHERE id = $1', [
      id,
    ]);
    expect(row.rows[0]?.status).toBe('succeeded');
  });

  it('frees the slot for the next sync', async () => {
    await withSyncRun(pool, USER, 'api', (run) => Promise.resolve(run.runId));
    await expect(withSyncRun(pool, USER, 'api', () => Promise.resolve('next'))).resolves.toBe(
      'next',
    );
  });
});
