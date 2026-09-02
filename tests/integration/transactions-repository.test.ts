import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { BankingApiClient } from '../../src/banking/client.js';
import type { BankingTransaction } from '../../src/banking/types.js';
import type { Database } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import type { CategoryResolver } from '../../src/modules/reliability/categories.js';
import { SyncService } from '../../src/modules/sync/service.js';
import { testPool } from '../helpers/db.js';

/**
 * Integration tier: ONE real boundary — Postgres. No HTTP, no app, no live
 * Banking API. When something here fails, the database layer is the only
 * suspect.
 *
 * These exercise `writePage` through `syncUser`, because the dedupe decision is
 * a property of the SQL — an `ON CONFLICT ... setWhere` and an archiving
 * INSERT — not of anything that can be unit tested.
 */
const pool = testPool();
afterAll(() => pool.end());

const db: Database = drizzle(pool, { schema });
const USER = 'user_repo';
const ACCOUNT = 'acc_repo';

const silentLog = { debug: () => undefined, warn: () => undefined, error: () => undefined };
const noCategories = {
  refreshFromUpstream: () => Promise.resolve(undefined),
  currentVersion: () => Promise.resolve(1),
} as unknown as CategoryResolver;

const txn = (over: Partial<BankingTransaction> = {}): BankingTransaction => ({
  id: 'txn_1',
  account_id: ACCOUNT,
  amount: -42.5,
  currency: 'EUR',
  date: '2025-10-05',
  description: 'Groceries',
  merchant_category_code: '5411',
  merchant_name: 'Supermarket',
  type: 'debit',
  ...over,
});

/** A sync that serves exactly the pages given, then stops. */
function servingOnce(pages: BankingTransaction[][], accounts = [ACCOUNT]) {
  return {
    getDataRange: () => Promise.resolve({ from: '2025-09-01', to: '2026-06-30' }),
    listAccounts: (userId: string) =>
      Promise.resolve(
        accounts.map((id) => ({
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
      for (const page of pages) yield page.filter((t) => t.account_id === accountId);
    },
  } as unknown as BankingApiClient;
}

const sync = (pages: BankingTransaction[][], accounts?: string[]) =>
  new SyncService(db, servingOnce(pages, accounts), pool, noCategories, silentLog).syncUser(USER);

const stored = async (id = 'txn_1') =>
  (
    await pool.query<{
      amount: string;
      category: string | null;
      description: string | null;
      revision: number;
      content_hash: string;
      status: string;
    }>(
      `SELECT amount, category, description, revision, content_hash, status
         FROM transactions WHERE id = $1`,
      [id],
    )
  ).rows[0];

beforeEach(async () => {
  await pool.query('DELETE FROM transaction_revisions WHERE transaction_id LIKE $1', ['txn_%']);
  await pool.query('DELETE FROM transactions WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM accounts WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM sync_runs WHERE user_id = $1', [USER]);
});

describe('dedupe by content hash', () => {
  it('a first insert writes the row and reports it as new', async () => {
    const res = await sync([[txn()]]);
    expect(res.new_transactions).toBe(1);
    expect(res.duplicate_transactions).toBe(0);
    expect((await stored())?.revision).toBe(1);
  });

  it('re-inserting an identical row reports a duplicate and does not bump revision', async () => {
    await sync([[txn()]]);
    const again = await sync([[txn()]]);
    expect(again.new_transactions).toBe(0);
    expect(again.duplicate_transactions).toBe(1);
    expect(again.amended_transactions).toBe(0);
    expect((await stored())?.revision).toBe(1);
  });

  it('a changed amount bumps revision and updates the row', async () => {
    await sync([[txn()]]);
    const amended = await sync([[txn({ amount: -99.99 })]]);
    expect(amended.amended_transactions).toBe(1);
    const row = await stored();
    expect(row?.amount).toBe('-99.99');
    expect(row?.revision).toBe(2);
  });

  it('a changed category bumps revision — categories feed scoring', async () => {
    await sync([[txn()]]);
    const amended = await sync([[txn({ merchant_category_code: '7995' })]]);
    expect(amended.amended_transactions).toBe(1);
    expect((await stored())?.category).toBe('7995');
  });

  /**
   * The hash covers only what a score depends on. A merchant renaming its
   * payment descriptor must not read as an amendment, or the drift alarm
   * fires on cosmetics.
   */
  it('a changed description alone does NOT bump revision', async () => {
    await sync([[txn()]]);
    const again = await sync([[txn({ description: 'SUPERMARKET LTD 4471' })]]);
    expect(again.amended_transactions).toBe(0);
    expect(again.duplicate_transactions).toBe(1);
    expect((await stored())?.revision).toBe(1);
  });

  it('the same id twice in one page resolves to one row, not a constraint error', async () => {
    // Upstream pagination is hostile: the same row can appear on two pages.
    const res = await sync([[txn()], [txn()]]);
    expect(res.new_transactions + res.duplicate_transactions).toBe(2);
    const { rows } = await pool.query<{ c: string }>(
      "SELECT count(*)::text AS c FROM transactions WHERE id = 'txn_1'",
    );
    expect(rows[0]?.c).toBe('1');
  });
});

describe('transaction_revisions', () => {
  const revisions = async () =>
    (
      await pool.query<{ revision: number; previous: Record<string, unknown> }>(
        `SELECT revision, previous FROM transaction_revisions
          WHERE transaction_id = 'txn_1' ORDER BY revision`,
      )
    ).rows;

  it('an amendment archives the previous row before overwriting', async () => {
    await sync([[txn()]]);
    await sync([[txn({ amount: -99.99 })]]);

    const archived = await revisions();
    expect(archived).toHaveLength(1);
    // The archive holds what we believed BEFORE, not the new value.
    // jsonb gives back a JS number; `normalise()` restores the canonical form.
    expect(Number(archived[0]?.previous['amount'])).toBe(-42.5);
    expect((await stored())?.amount).toBe('-99.99');
  });

  it('the archived row contains the full prior state, not just changed fields', async () => {
    await sync([[txn()]]);
    await sync([[txn({ amount: -99.99 })]]);
    const previous = (await revisions())[0]?.previous ?? {};
    // Everything a rebuild needs must be there, not only `amount`.
    for (const key of ['id', 'account_id', 'user_id', 'booked_at', 'category', 'is_credit']) {
      expect(previous).toHaveProperty(key);
    }
  });

  it('records one revision per amendment, and none for a duplicate', async () => {
    await sync([[txn()]]);
    await sync([[txn()]]); // duplicate — archives nothing
    expect(await revisions()).toHaveLength(0);

    await sync([[txn({ amount: -1 })]]);
    await sync([[txn({ amount: -2 })]]);
    expect((await revisions()).map((r) => r.revision)).toEqual([2, 3]);
  });
});

describe('sync_runs.covered_account_ids', () => {
  const run = async () =>
    (
      await pool.query<{ covered_account_ids: string[]; status: string }>(
        `SELECT covered_account_ids, status FROM sync_runs
          WHERE user_id = $1 ORDER BY started_at DESC LIMIT 1`,
        [USER],
      )
    ).rows[0];

  it('lists an account only when its walk completed', async () => {
    await sync([[txn()]]);
    expect((await run())?.covered_account_ids).toEqual([ACCOUNT]);
  });

  it('records ids, not a count — so a swapped account is detectable', async () => {
    await sync(
      [[txn({ account_id: 'acc_a' }), txn({ id: 'txn_2', account_id: 'acc_b' })]],
      ['acc_a', 'acc_b'],
    );
    const covered = (await run())?.covered_account_ids ?? [];
    // A count of 2 would be satisfied by any two accounts; ids are not.
    expect([...covered].sort()).toEqual(['acc_a', 'acc_b']);
  });

  it('is readable by the next sync, which is what coverage depends on', async () => {
    await sync([[txn()]]);
    await sync([[txn()]]);
    const { rows } = await pool.query<{ c: string }>(
      "SELECT count(*)::text AS c FROM sync_runs WHERE user_id = $1 AND status = 'succeeded'",
      [USER],
    );
    expect(Number(rows[0]?.c)).toBe(2);
  });
});

describe('money', () => {
  it('numeric(14,2) round-trips without floating-point drift', async () => {
    // 0.1 + 0.2 territory: these are exactly the values a float mangles.
    await sync([
      [
        txn({ id: 'txn_a', amount: -0.1 }),
        txn({ id: 'txn_b', amount: -0.2 }),
        txn({ id: 'txn_c', amount: -12345678.99 }),
      ],
    ]);
    expect((await stored('txn_a'))?.amount).toBe('-0.10');
    expect((await stored('txn_b'))?.amount).toBe('-0.20');
    expect((await stored('txn_c'))?.amount).toBe('-12345678.99');
  });

  it('amounts come back as strings, not JS numbers', async () => {
    await sync([[txn()]]);
    expect(typeof (await stored())?.amount).toBe('string');
  });
});

describe('the scoring query', () => {
  it('selects only status = active', async () => {
    await sync([[txn(), txn({ id: 'txn_dead' })]]);
    await pool.query("UPDATE transactions SET status = 'reversed' WHERE id = 'txn_dead'");
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM transactions
        WHERE user_id = $1 AND status = 'active'
          AND booked_at BETWEEN $2::date AND $3::date`,
      [USER, '2025-09-01', '2026-02-20'],
    );
    expect(rows.map((r) => r.id)).toEqual(['txn_1']);
  });

  it('treats the window boundaries as inclusive', async () => {
    await sync([
      [
        txn({ id: 'txn_first', date: '2025-09-01' }),
        txn({ id: 'txn_last', date: '2026-02-20' }),
        txn({ id: 'txn_before', date: '2025-08-31' }),
      ],
    ]);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM transactions
        WHERE user_id = $1 AND booked_at BETWEEN $2::date AND $3::date ORDER BY id`,
      [USER, '2025-09-01', '2026-02-20'],
    );
    expect(rows.map((r) => r.id)).toEqual(['txn_first', 'txn_last']);
  });
});
