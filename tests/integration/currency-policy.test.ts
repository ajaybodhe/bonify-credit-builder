import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { BankingApiClient } from '../../src/banking/client.js';
import type { BankingTransaction } from '../../src/banking/types.js';
import type { Database } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import type { CategoryResolver } from '../../src/modules/reliability/categories.js';
import { SyncService } from '../../src/modules/sync/service.js';
import { collectMetrics, pointWith } from '../helpers/metrics.js';
import { testPool } from '../helpers/db.js';
import type * as SyncModule from '../../src/modules/sync/service.js';

/**
 * Single-currency policy: non-EUR rows are dropped at ingest, counted, and
 * never converted or combined. Documented in docs/scoring-model.md.
 *
 * Integration tier because the drop happens on the way into Postgres — the
 * assertion that matters is which rows are *in the table* afterwards, which no
 * mock can answer.
 */
const pool = testPool();
afterAll(() => pool.end());

const db: Database = drizzle(pool, { schema });
const USER = 'user_currency';
const EUR_ACCOUNT = 'acc_cur_eur';
const USD_ACCOUNT = 'acc_cur_usd';

const silentLog = { debug: () => undefined, warn: () => undefined, error: () => undefined };
const noCategories = {
  refreshFromUpstream: () => Promise.resolve(undefined),
  currentVersion: () => Promise.resolve(1),
} as unknown as CategoryResolver;

const txn = (over: Partial<BankingTransaction> = {}): BankingTransaction => ({
  id: 'txn_cur_1',
  account_id: EUR_ACCOUNT,
  amount: -42.5,
  currency: 'EUR',
  date: '2025-10-05',
  description: 'Groceries',
  merchant_category_code: '5411',
  merchant_name: 'Supermarket',
  type: 'debit',
  ...over,
});

/** Serves the given pages, with per-account currencies the caller chooses. */
function serving(pages: BankingTransaction[][], accounts: Record<string, string>) {
  return {
    getDataRange: () => Promise.resolve({ from: '2025-09-01', to: '2026-06-30' }),
    listAccounts: (userId: string) =>
      Promise.resolve(
        Object.entries(accounts).map(([id, currency]) => ({
          id,
          user_id: userId,
          type: 'checking' as const,
          currency,
          balance: 1000,
          name: id,
        })),
      ),
    // eslint-disable-next-line @typescript-eslint/require-await
    async *streamTransactions(accountId: string) {
      for (const page of pages) yield page.filter((t) => t.account_id === accountId);
    },
  } as unknown as BankingApiClient;
}

const sync = (pages: BankingTransaction[][], accounts: Record<string, string>) =>
  new SyncService(db, serving(pages, accounts), pool, noCategories, silentLog).syncUser(USER);

const storedIds = async (): Promise<string[]> =>
  (
    await pool.query<{ id: string }>('SELECT id FROM transactions WHERE user_id = $1 ORDER BY id', [
      USER,
    ])
  ).rows.map((r) => r.id);

const storedAccounts = async (): Promise<string[]> =>
  (
    await pool.query<{ id: string }>('SELECT id FROM accounts WHERE user_id = $1 ORDER BY id', [
      USER,
    ])
  ).rows.map((r) => r.id);

beforeEach(async () => {
  await pool.query('DELETE FROM transactions WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM accounts WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM sync_runs WHERE user_id = $1', [USER]);
});

describe('non-EUR transactions are dropped, the rest of the page is kept', () => {
  it('stores the EUR rows and not the foreign one', async () => {
    const res = await sync(
      [
        [
          txn({ id: 'txn_cur_eur_a' }),
          txn({ id: 'txn_cur_usd', currency: 'USD', amount: -100 }),
          txn({ id: 'txn_cur_eur_b', date: '2025-10-06' }),
        ],
      ],
      { [EUR_ACCOUNT]: 'EUR' },
    );

    expect(await storedIds()).toEqual(['txn_cur_eur_a', 'txn_cur_eur_b']);
    expect(res.new_transactions).toBe(2);
  });

  it('says so in the response rather than dropping them silently', async () => {
    const res = await sync([[txn(), txn({ id: 'txn_cur_gbp', currency: 'GBP' })]], {
      [EUR_ACCOUNT]: 'EUR',
    });
    expect(res.warnings.join(' ')).toMatch(/1 transaction\(s\) skipped as non-EUR/);
  });

  /** A page that is entirely foreign must not reach the INSERT at all. */
  it('handles a page with nothing left after filtering', async () => {
    const res = await sync([[txn({ id: 'txn_cur_chf', currency: 'CHF' })]], {
      [EUR_ACCOUNT]: 'EUR',
    });
    expect(await storedIds()).toEqual([]);
    expect(res.new_transactions).toBe(0);
    expect(res.status).toBe('succeeded');
  });
});

describe('non-EUR accounts are dropped whole', () => {
  /**
   * Balance included, deliberately: `accounts.current_balance` anchors the
   * negative-balance reconstruction, so a USD balance would silently anchor a
   * EUR series.
   */
  it('never stores the account, and never walks it', async () => {
    const res = await sync([[txn(), txn({ id: 'txn_cur_on_usd', account_id: USD_ACCOUNT })]], {
      [EUR_ACCOUNT]: 'EUR',
      [USD_ACCOUNT]: 'USD',
    });

    expect(await storedAccounts()).toEqual([EUR_ACCOUNT]);
    expect(await storedIds()).toEqual(['txn_cur_1']);
    expect(res.synced_accounts).toBe(1);
    expect(res.warnings.join(' ')).toMatch(/1 account\(s\) skipped as non-EUR/);
  });

  /** Regression: filtering can empty the list, and an empty VALUES throws. */
  it('a user whose accounts are all non-EUR syncs cleanly instead of throwing', async () => {
    const res = await sync([[]], { [USD_ACCOUNT]: 'USD' });
    expect(res.status).toBe('succeeded');
    expect(res.synced_accounts).toBe(0);
    expect(await storedAccounts()).toEqual([]);
  });
});

describe('a dictionary that cannot be refreshed is reported, not just logged', () => {
  /**
   * Upstream adding a category group fails the whole refresh — one unknown group
   * rejects every valid entry with it. That is the safe direction (a partial
   * dictionary would silently drop codes), but it freezes scoring on the last
   * stored version, and the caller has to be told.
   */
  it('warns in the sync response when the refresh fails', async () => {
    const failing = {
      refreshFromUpstream: () => Promise.reject(new Error('unknown category group')),
      currentVersion: () => Promise.resolve(1),
    } as unknown as CategoryResolver;

    const res = await new SyncService(
      db,
      serving([[txn()]], { [EUR_ACCOUNT]: 'EUR' }),
      pool,
      failing,
      silentLog,
    ).syncUser(USER);

    expect(res.status).toBe('succeeded');
    expect(res.warnings.join(' ')).toMatch(/could not be refreshed/);
  });
});

describe('sync.non_eur_skipped', () => {
  it('counts what was dropped, split by kind and currency', async () => {
    const m = collectMetrics();
    try {
      const { SyncService: Service } = await m.load<typeof SyncModule>(
        '../../src/modules/sync/service.js',
      );
      await new Service(
        db,
        serving([[txn(), txn({ id: 'txn_cur_usd', currency: 'USD' })]], {
          [EUR_ACCOUNT]: 'EUR',
          [USD_ACCOUNT]: 'USD',
        }),
        pool,
        noCategories,
        silentLog,
      ).syncUser(USER);

      const points = await m.read('sync.non_eur_skipped');
      expect(pointWith(points, { kind: 'transaction', currency: 'USD' })?.value).toBe(1);
      expect(pointWith(points, { kind: 'account', currency: 'USD' })?.value).toBe(1);
    } finally {
      await m.shutdown();
    }
  });
});
