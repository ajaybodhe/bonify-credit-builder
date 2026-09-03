import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withReadSnapshot } from '../../src/db/read-snapshot.js';
import { deferred, testPool } from '../helpers/db.js';

/**
 * Isolation guarantees for the scoring read path, against real Postgres —
 * MVCC behaviour cannot be meaningfully mocked.
 */
const pool = testPool();
afterAll(() => pool.end());

const USER = 'user_isolation_test';

async function seed(count: number) {
  await pool.query('DELETE FROM sync_runs WHERE user_id = $1', [USER]);
  for (let i = 0; i < count; i++) {
    await pool.query(
      "INSERT INTO sync_runs (id, user_id, status, started_at) VALUES ($1, $2, 'succeeded', now())",
      [`${USER}_seed_${String(i)}`, USER],
    );
  }
}

const countRows = async (client: { query: typeof pool.query }) =>
  Number(
    (
      await client.query<{ c: string }>(
        'SELECT count(*)::text AS c FROM sync_runs WHERE user_id = $1',
        [USER],
      )
    ).rows[0]?.c ?? '0',
  );

describe('withReadSnapshot', () => {
  beforeEach(() => seed(2));

  /**
   * The read-skew guarantee. Two reads inside one snapshot must agree even
   * though a concurrent writer commits between them — otherwise scoring can
   * assemble a score from two different instants and store an `input_hash`
   * describing a state that never existed.
   */
  it('does not see a write committed after the snapshot opened', async () => {
    const opened = deferred();
    const written = deferred();

    const reader = withReadSnapshot(pool, async (client) => {
      const before = await countRows(client);
      opened.resolve();
      await written.promise;
      const after = await countRows(client);
      return { before, after };
    });

    await opened.promise;
    await pool.query(
      "INSERT INTO sync_runs (id, user_id, status, started_at) VALUES ($1, $2, 'succeeded', now())",
      [`${USER}_late`, USER],
    );
    written.resolve();

    const { before, after } = await reader;
    expect(before).toBe(2);
    expect(after).toBe(2); // the concurrent insert is invisible to this snapshot
  });

  it('a snapshot opened AFTER the write does see it', async () => {
    // Self-contained: does not rely on state left by another test.
    expect(await withReadSnapshot(pool, (c) => countRows(c))).toBe(2);
    await pool.query(
      "INSERT INTO sync_runs (id, user_id, status, started_at) VALUES ($1, $2, 'succeeded', now())",
      [`${USER}_after`, USER],
    );
    expect(await withReadSnapshot(pool, (c) => countRows(c))).toBe(3);
  });

  /** READ ONLY is enforced by the database, not by our discipline. */
  it('rejects a write attempted from inside the read path', async () => {
    await expect(
      withReadSnapshot(pool, (client) =>
        client.query(
          "INSERT INTO sync_runs (id, user_id, status, started_at) VALUES ('nope', $1, 'succeeded', now())",
          [USER],
        ),
      ),
    ).rejects.toThrow(/read-only transaction/i);
  });

  it('does not block a concurrent writer', async () => {
    const opened = deferred();
    const reader = withReadSnapshot(pool, async (client) => {
      await countRows(client);
      opened.resolve();
      // Hold the snapshot open while a writer commits.
      await new Promise((r) => setTimeout(r, 50));
      return 'done';
    });
    await opened.promise;
    // If the reader took locks this would stall rather than return promptly.
    await expect(
      pool.query(
        "INSERT INTO sync_runs (id, user_id, status, started_at) VALUES ($1, $2, 'succeeded', now())",
        [`${USER}_concurrent`, USER],
      ),
    ).resolves.toBeDefined();
    await expect(reader).resolves.toBe('done');
  });

  it('releases the connection when the callback throws', async () => {
    await expect(
      withReadSnapshot(pool, () => Promise.reject(new Error('scoring blew up'))),
    ).rejects.toThrow('scoring blew up');
    // Exhaust more than the pool size to prove nothing leaked.
    for (let i = 0; i < 12; i++) {
      await withReadSnapshot(pool, () => Promise.resolve(i));
    }
  });
});
