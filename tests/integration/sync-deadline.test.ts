import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BankingApiClient } from '../../src/banking/client.js';
import type { BankingTransaction } from '../../src/banking/types.js';
import type { Database } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import type { CategoryResolver } from '../../src/modules/reliability/categories.js';
import { SyncService } from '../../src/modules/sync/service.js';
import { testPool } from '../helpers/db.js';

/** Silent by default; a test that cares about a log line can assert on the calls. */
const silentLog = { debug: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * The sync deadline.
 *
 * A Banking API sick enough to keep us past the deadline is one to back away
 * from rather than keep hammering: the run stops itself, keeps whatever
 * committed, and reports honestly that it did not finish. That self-abort is
 * also what lets reclamation key on `started_at` — a live run always stops
 * before the reclaim window opens, so a reclaimable row has no live owner.
 *
 * Integration tier: the abort is only meaningful against real committed rows
 * and a real `sync_runs` row. The upstream is stubbed because the point is its
 * SLOWNESS, which a real one cannot be asked to reproduce on demand.
 */
const pool = testPool();
afterAll(() => pool.end());

const USER = 'user_deadline';
const db: Database = drizzle(pool, { schema });

/** An upstream that answers, but always too slowly. */
function molasses(accounts: string[], delayMs: number): BankingApiClient {
  return {
    getDataRange: () => Promise.resolve({ from: '2025-09-01', to: '2026-06-30' }),
    listAccounts: (userId: string) =>
      Promise.resolve(
        accounts.map((id) => ({
          id,
          user_id: userId,
          type: 'checking' as const,
          currency: 'EUR',
          balance: 100,
          name: id,
        })),
      ),
    async *streamTransactions(accountId: string) {
      for (let page = 0; page < 3; page++) {
        await new Promise((r) => setTimeout(r, delayMs));
        yield [
          {
            id: `${accountId}_p${String(page)}`,
            account_id: accountId,
            amount: -10,
            currency: 'EUR',
            date: '2025-10-01',
            description: 'slow',
            merchant_category_code: '5411',
            merchant_name: 'shop',
            type: 'debit',
          },
        ] as unknown as BankingTransaction[];
      }
    },
  } as unknown as BankingApiClient;
}

const noCategories = {
  refreshFromUpstream: () => Promise.resolve(undefined),
  // The sync records the version in force when it finishes; this stub has none.
  currentVersion: () => Promise.resolve(null),
} as unknown as CategoryResolver;

beforeEach(async () => {
  await pool.query('DELETE FROM transactions WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM accounts WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM sync_runs WHERE user_id = $1', [USER]);
});

/**
 * `SyncService` is constructed once for the app and shared by every request, so
 * anything it remembers between calls leaks across users. The error text is the
 * dangerous one: it is written to `sync_runs.error`, the table the design calls
 * the answer to "was this score computed on good data?".
 */
describe("one user's failure never reaches another user's run", () => {
  const OTHER = 'user_deadline_other';

  /** Fails for one user's account, succeeds for the other's — one instance, both users. */
  function selective(): BankingApiClient {
    return {
      getDataRange: () => Promise.resolve({ from: '2025-09-01', to: '2026-06-30' }),
      listAccounts: (userId: string) =>
        Promise.resolve([
          {
            id: userId === USER ? 'acc_fails' : 'acc_fine',
            user_id: userId,
            type: 'checking' as const,
            currency: 'EUR',
            balance: 100,
            name: 'a',
          },
        ]),
      // eslint-disable-next-line @typescript-eslint/require-await
      async *streamTransactions(accountId: string) {
        if (accountId === 'acc_fails') throw new Error('SECRET-FROM-FIRST-USER');
        yield [] as unknown as BankingTransaction[];
      },
    } as unknown as BankingApiClient;
  }

  afterEach(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [OTHER]);
    await pool.query('DELETE FROM accounts WHERE user_id = $1', [OTHER]);
    await pool.query('DELETE FROM sync_runs WHERE user_id = $1', [OTHER]);
  });

  it("does not copy a failed run's error onto the next user's row", async () => {
    const service = new SyncService(db, selective(), pool, noCategories, silentLog, 10_000);

    const failed = await service.syncUser(USER);
    expect(failed.accounts_failed).toBe(1);

    const clean = await service.syncUser(OTHER);
    expect(clean.status).toBe('succeeded');

    const { rows } = await pool.query<{ error: string | null }>(
      'SELECT error FROM sync_runs WHERE user_id = $1 ORDER BY started_at DESC LIMIT 1',
      [OTHER],
    );
    expect(rows[0]?.error ?? '').not.toContain('SECRET-FROM-FIRST-USER');
    expect(rows[0]?.error).toBeNull();
  });

  it("the failing user's own run still records its error", async () => {
    // The fix must not lose the error, only stop it travelling.
    const service = new SyncService(db, selective(), pool, noCategories, silentLog, 10_000);
    await service.syncUser(USER);
    const { rows } = await pool.query<{ error: string | null }>(
      'SELECT error FROM sync_runs WHERE user_id = $1 ORDER BY started_at DESC LIMIT 1',
      [USER],
    );
    expect(rows[0]?.error).toContain('SECRET-FROM-FIRST-USER');
  });
});

/**
 * The deadline has to reach INSIDE a request, not merely between them.
 *
 * Checking at page boundaries bounds the gaps; one page can still consume the
 * whole retry budget. The reclaim rule assumes a live run always stops before
 * its slot can be taken, so if a single call can outlast the deadline, that
 * assumption is false and two syncs can run for one user.
 */
describe('the deadline reaches inside a request', () => {
  it('aborts a page that never returns, rather than waiting it out', async () => {
    let aborted = false;
    const hanging = {
      getDataRange: () => Promise.resolve({ from: '2025-09-01', to: '2026-06-30' }),
      listAccounts: (userId: string) =>
        Promise.resolve([
          {
            id: 'acc_hang',
            user_id: userId,
            type: 'checking' as const,
            currency: 'EUR',
            balance: 10,
            name: 'h',
          },
        ]),
      async *streamTransactions(_id: string, _range: unknown, signal?: AbortSignal) {
        // A request that would never resolve on its own.
        await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        });
        yield [] as never;
      },
    } as unknown as BankingApiClient;

    const startedAt = Date.now();
    const res = await new SyncService(db, hanging, pool, noCategories, silentLog, 150).syncUser(
      USER,
    );

    // Without the signal this never returns: the generator has no timeout of
    // its own and the boundary check is never reached.
    expect(aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(res.accounts_failed).toBe(1);
  });
});

describe('a sync that outlives its deadline', () => {
  it('stops early instead of running to completion', async () => {
    const service = new SyncService(
      db,
      molasses(['acc_d1', 'acc_d2'], 60),
      pool,
      noCategories,
      silentLog,
      80,
    );
    const startedAt = Date.now();
    const res = await service.syncUser(USER);

    // Two accounts x three 60ms pages would be ~360ms if it ran to the end.
    expect(Date.now() - startedAt).toBeLessThan(300);
    expect(res.status).toBe('partial');
  });

  it('keeps the pages that committed before it gave up', async () => {
    const service = new SyncService(
      db,
      molasses(['acc_d1'], 60),
      pool,
      noCategories,
      silentLog,
      80,
    );
    await service.syncUser(USER);
    const { rows } = await pool.query<{ c: string }>(
      'SELECT count(*)::text AS c FROM transactions WHERE user_id = $1',
      [USER],
    );
    // Not zero — the abort is not a rollback.
    expect(Number(rows[0]?.c)).toBeGreaterThan(0);
  });

  /**
   * The safety property. A walk cut short is a random subset of the range, so
   * claiming coverage for it would let scoring run on a hole it cannot see.
   */
  it('claims no coverage for the account it abandoned mid-walk', async () => {
    const service = new SyncService(
      db,
      molasses(['acc_d1'], 60),
      pool,
      noCategories,
      silentLog,
      80,
    );
    await service.syncUser(USER);
    const { rows } = await pool.query<{ covered: string[] | null; status: string }>(
      'SELECT covered_account_ids AS covered, status FROM sync_runs WHERE user_id = $1',
      [USER],
    );
    expect(rows[0]?.covered ?? []).toEqual([]);
    expect(rows[0]?.status).toBe('partial');
  });

  it('says so in the response and on the run, rather than reporting success', async () => {
    const service = new SyncService(
      db,
      molasses(['acc_d1'], 60),
      pool,
      noCategories,
      silentLog,
      80,
    );
    const res = await service.syncUser(USER);
    expect(res.warnings.join(' ')).toMatch(/deadline/i);
    expect(res.accounts_failed).toBe(1);

    const { rows } = await pool.query<{ error: string | null }>(
      'SELECT error FROM sync_runs WHERE user_id = $1',
      [USER],
    );
    expect(rows[0]?.error).toMatch(/deadline/i);
  });

  it('frees the slot, so the retry it asks for is actually possible', async () => {
    const service = new SyncService(
      db,
      molasses(['acc_d1'], 60),
      pool,
      noCategories,
      silentLog,
      80,
    );
    await service.syncUser(USER);
    // A run left `running` would wedge the user until reclamation.
    const { rows } = await pool.query<{ c: string }>(
      "SELECT count(*)::text AS c FROM sync_runs WHERE user_id = $1 AND status = 'running'",
      [USER],
    );
    expect(rows[0]?.c).toBe('0');
  });

  it('does not fire when upstream is healthy', async () => {
    const service = new SyncService(
      db,
      molasses(['acc_d1'], 1),
      pool,
      noCategories,
      silentLog,
      10_000,
    );
    const res = await service.syncUser(USER);
    expect(res.status).toBe('succeeded');
    expect(res.warnings).toEqual([]);
    expect(res.accounts_failed).toBe(0);
  });
});
