import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { classifyTransfers, type AccountType } from '../../src/modules/reliability/transfers.js';
import type { Transaction } from '../../src/db/schema.js';

function txn(
  over: Partial<Transaction> & Pick<Transaction, 'id' | 'amount' | 'isCredit'>,
): Transaction {
  return {
    accountId: 'acc_chk',
    userId: 'user_1001',
    bookedAt: '2026-01-15',
    currency: 'EUR',
    description: null,
    merchant: null,
    category: null,
    status: 'active',
    contentHash: 'h',
    revision: 1,
    ingestedAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

const ACCOUNTS = new Map<string, AccountType>([
  ['acc_chk', 'checking'],
  ['acc_chk2', 'checking'],
  ['acc_sav', 'savings'],
]);
const SAVINGS_CODES = new Set(['6540']);
const classify = (ts: Transaction[]) => classifyTransfers(ts, ACCOUNTS, SAVINGS_CODES);

/**
 * Identification works without linking the two legs, because either signal is
 * enough on its own: where the money landed, or how the provider labelled it.
 * These two pin the edges of that — one where a signal is present but the
 * category is not, one where neither signal is present at all.
 */
describe('identification without linkage', () => {
  /**
   * The account type alone decides. Documented in `transfers.ts`, and easy to
   * regress into requiring a category code — which would silently start
   * counting uncoded savings deposits as income.
   */
  it('a credit into savings with NO savings code is still saving, not income', () => {
    const r = classify([
      txn({ id: 't', amount: '300.00', isCredit: true, accountId: 'acc_sav', category: null }),
    ]);
    expect(r.savingsInIds.has('t')).toBe(true);
    expect(r.excludedFromIncome.has('t')).toBe(true);
  });

  /**
   * The documented gap: a transfer from the user's own account at ANOTHER bank
   * lands in checking, carries no savings code, and has no second leg here — so
   * neither signal fires and nothing can pair it. It counts as income.
   *
   * This asserts the limitation rather than the fix, deliberately: it is what
   * `docs/scoring-model.md` publishes, and a future "exclude anything that looks
   * round and recurring" heuristic would break it — which is the point, because
   * a false positive erases real income.
   */
  it('an uncoded, unpaired credit into checking IS counted as income', () => {
    const r = classify([
      txn({ id: 't', amount: '300.00', isCredit: true, accountId: 'acc_chk', category: null }),
    ]);
    expect(r.excludedFromIncome.has('t')).toBe(false);
    expect(r.savingsInIds.has('t')).toBe(false);
  });
});

describe('direction decides the treatment', () => {
  it('a credit into savings is saving, and is NOT income', () => {
    const r = classify([
      txn({ id: 't', amount: '300.00', isCredit: true, accountId: 'acc_sav', category: '6540' }),
    ]);
    expect(r.savingsInIds.has('t')).toBe(true);
    expect(r.excludedFromIncome.has('t')).toBe(true);
    expect(r.savingsOutIds.has('t')).toBe(false);
  });

  /** The bug the account-type rule fixes: a withdrawal is the opposite of saving. */
  it('a debit out of savings is dis-saving, never counted as saving', () => {
    const r = classify([
      txn({ id: 't', amount: '-300.00', isCredit: false, accountId: 'acc_sav', category: '6540' }),
    ]);
    expect(r.savingsOutIds.has('t')).toBe(true);
    expect(r.savingsInIds.has('t')).toBe(false);
    expect(r.excludedFromSpend.has('t')).toBe(true);
  });

  it('a transfer-coded credit into checking is money leaving savings, not income', () => {
    const r = classify([
      txn({ id: 't', amount: '300.00', isCredit: true, accountId: 'acc_chk', category: '6540' }),
    ]);
    expect(r.excludedFromIncome.has('t')).toBe(true);
    expect(r.savingsOutIds.has('t')).toBe(true);
  });

  it('a transfer-coded debit from checking is money going to savings, not spend', () => {
    const r = classify([
      txn({ id: 't', amount: '-300.00', isCredit: false, accountId: 'acc_chk', category: '6540' }),
    ]);
    expect(r.excludedFromSpend.has('t')).toBe(true);
    expect(r.savingsInIds.has('t')).toBe(true);
  });

  /**
   * checking → checking credits no savings — neither leg touches a savings
   * account. It is also NOT identified as a transfer: nothing in either row
   * says so, and inferring it from a matching amount and date would guess
   * wrongly whenever two unrelated payments coincide. So the credit counts as
   * income, exactly like the external-bank case.
   */
  it('a checking-to-checking shuffle credits no savings, and is not identified', () => {
    const r = classify([
      txn({ id: 'd', amount: '-500.00', isCredit: false, accountId: 'acc_chk' }),
      txn({ id: 'c', amount: '500.00', isCredit: true, accountId: 'acc_chk2' }),
    ]);
    expect(r.savingsInIds.size).toBe(0);
    expect(r.savingsOutIds.size).toBe(0);
    expect(r.excludedFromIncome.has('c')).toBe(false);
    expect(r.excludedFromSpend.has('d')).toBe(false);
  });

  it('leaves genuine salary alone', () => {
    const r = classify([
      txn({
        id: 'salary',
        amount: '2400.00',
        isCredit: true,
        accountId: 'acc_chk',
        category: '9001',
      }),
    ]);
    expect(r.excludedFromIncome.has('salary')).toBe(false);
  });

  it('leaves genuine spending alone', () => {
    const r = classify([
      txn({
        id: 'shop',
        amount: '-42.00',
        isCredit: false,
        accountId: 'acc_chk',
        category: '5411',
      }),
    ]);
    expect(r.excludedFromSpend.has('shop')).toBe(false);
  });

  it('treats an unknown account as checking rather than inventing savings', () => {
    const r = classify([
      txn({ id: 't', amount: '300.00', isCredit: true, accountId: 'acc_unknown' }),
    ]);
    expect(r.savingsInIds.size).toBe(0);
  });
});

/**
 * Driven by a captured response from the live API, so the assumption that broke
 * the first implementation cannot silently return: this provider reports an
 * internal transfer as a SINGLE-SIDED credit into savings, with no matching
 * debit anywhere.
 */
describe('against the real acc_1001_sav fixture', () => {
  const raw = JSON.parse(
    readFileSync(new URL('../fixtures/transactions.acc_1001_sav.json', import.meta.url), 'utf8'),
  ) as {
    transactions: {
      id: string;
      amount: number;
      date: string;
      merchant_category_code: string;
      type: string;
    }[];
  };

  const rows = raw.transactions.map((t) =>
    txn({
      id: t.id,
      amount: t.amount.toFixed(2),
      isCredit: t.type === 'credit',
      accountId: 'acc_sav',
      bookedAt: t.date,
      category: t.merchant_category_code,
    }),
  );

  it('the fixture really is single-sided credits coded 6540', () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((t) => t.isCredit && t.category === '6540')).toBe(true);
  });

  it('every one is treated as saving and none as income', () => {
    const r = classify(rows);
    expect(r.savingsInIds.size).toBe(rows.length);
    expect(r.excludedFromIncome.size).toBe(rows.length);
  });

  /**
   * The regression that matters. Component A counts "at least one credit" as
   * income, so without this classification these seven transfers would read as
   * seven months of income the household never received.
   */
  it('no transfer survives into the income set', () => {
    const r = classify(rows);
    const wouldCountAsIncome = rows.filter((t) => t.isCredit && !r.excludedFromIncome.has(t.id));
    expect(wouldCountAsIncome).toEqual([]);
  });

  it('excludes nothing from spending — every row here is a credit', () => {
    // The savings-debit rule is the only source of spend exclusions, and this
    // account has no debits: the provider emits one leg, on the receiving side.
    expect(classify(rows).excludedFromSpend.size).toBe(0);
  });
});
