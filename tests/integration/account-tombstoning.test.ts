import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { BankingApiClient } from '../../src/banking/client.js';
import type { BankingTransaction } from '../../src/banking/types.js';
import type { Database } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import { assessCoverage } from '../../src/modules/reliability/coverage.js';
import type { CategoryResolver } from '../../src/modules/reliability/categories.js';
import { SyncService } from '../../src/modules/sync/service.js';
import { scoringWindow } from '../../src/lib/date.js';
import { testPool } from '../helpers/db.js';

/**
 * The Banking API publishes no deletion signal, so an account that closes just
 * stops appearing. Absence from a successful listing is the only evidence there
 * is, and a closed account can never be re-fetched — so coverage has to stop
 * demanding it, or the user is refused forever.
 */
const pool = testPool();
afterAll(() => pool.end());

const db: Database = drizzle(pool, { schema });
const USER = 'user_tombstone';
const KEPT = 'acc_tomb_kept';
const CLOSED = 'acc_tomb_closed';

const silentLog = { debug: () => undefined, warn: () => undefined, error: () => undefined };
const noCategories = {
  refreshFromUpstream: () => Promise.resolve(undefined),
  currentVersion: () => Promise.resolve(1),
} as unknown as CategoryResolver;

const txn = (accountId: string, id: string): BankingTransaction => ({
  id,
  account_id: accountId,
  amount: -42.5,
  currency: 'EUR',
  date: '2025-10-05',
  description: 'Groceries',
  merchant_category_code: '5411',
  merchant_name: 'Supermarket',
  type: 'debit',
});

/** Publishes exactly the accounts named, with a transaction on each. */
function serving(accountIds: string[]) {
  return {
    getDataRange: () => Promise.resolve({ from: '2025-09-01', to: '2026-06-30' }),
    listAccounts: (userId: string) =>
      Promise.resolve(
        accountIds.map((id) => ({
          id,
          user_id: userId,
          type: 'checking' as const,
          currency: 'EUR',
          balance: 1000,
          name: id,
        })),
      ),
    // eslint-disable-next-line @typescript-eslint/require-await
    async *streamTransactions(accountId: string) {
      yield [txn(accountId, `txn_tomb_${accountId}`)];
    },
  } as unknown as BankingApiClient;
}

const sync = (accountIds: string[]) =>
  new SyncService(db, serving(accountIds), pool, noCategories, silentLog).syncUser(USER);

const statuses = async (): Promise<Record<string, string>> =>
  Object.fromEntries(
    (
      await pool.query<{ id: string; status: string }>(
        'SELECT id, status FROM accounts WHERE user_id = $1 ORDER BY id',
        [USER],
      )
    ).rows.map((r) => [r.id, r.status]),
  );

beforeEach(async () => {
  await pool.query('DELETE FROM transactions WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM accounts WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM sync_runs WHERE user_id = $1', [USER]);
});

describe('an account that stops being published is marked dormant', () => {
  it('marks it dormant without deleting it, and leaves the other alone', async () => {
    await sync([KEPT, CLOSED]);
    expect(await statuses()).toEqual({ [KEPT]: 'active', [CLOSED]: 'active' });

    await sync([KEPT]);
    expect(await statuses()).toEqual({ [KEPT]: 'active', [CLOSED]: 'dormant' });
  });

  /** Marked, never deleted — the history stays scoreable and auditable. */
  it('keeps the dormant account transactions', async () => {
    await sync([KEPT, CLOSED]);
    await sync([KEPT]);
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text n FROM transactions WHERE account_id = $1',
      [CLOSED],
    );
    expect(rows[0]?.n).toBe('1');
  });

  /** A one-off upstream omission must not sideline an account permanently. */
  it('reactivates it if upstream publishes it again', async () => {
    await sync([KEPT, CLOSED]);
    await sync([KEPT]);
    await sync([KEPT, CLOSED]);
    expect(await statuses()).toEqual({ [KEPT]: 'active', [CLOSED]: 'active' });
  });
});

describe('coverage stops demanding a dormant account', () => {
  /**
   * The bug this fixes: the closed account can never be walked again, so it
   * could never be covered, so the user could never be scored.
   */
  it('is incomplete while the account is active, complete once dormant', async () => {
    await sync([KEPT, CLOSED]);
    // Only the kept account was walked in a later run, so the closed one is a gap.
    await pool.query('DELETE FROM sync_runs WHERE user_id = $1', [USER]);
    await sync([KEPT]);

    const window = scoringWindow('2026-02-20');
    const client = await pool.connect();
    try {
      const coverage = await assessCoverage(client, USER, window);
      expect(coverage.accounts_total).toBe(1);
      expect(coverage.gaps).toEqual([]);
      expect(coverage.complete).toBe(true);
    } finally {
      client.release();
    }
  });
});
