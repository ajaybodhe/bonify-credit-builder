import type { BankingTransaction } from '../../src/banking/types.js';

/**
 * A test double for the Banking API that reproduces its *hostile* properties,
 * not its convenient ones.
 *
 * A fake that returns tidy date-ordered pages would let a cursor-resuming
 * implementation pass every test and then lose data in production. So this one
 * deliberately models what the real API was observed to do on 2026-08-29:
 *
 *  - `from` and `to` are REQUIRED (400 otherwise)
 *  - page size 15
 *  - `next_cursor` is base64 of `{"offset":N}` — a positional offset
 *  - ordering is arbitrary with respect to date, but DETERMINISTIC for a fixed
 *    (accountId, from, to)
 *  - changing `to` reshuffles the result set, so the same offset yields
 *    different rows
 *
 * That last property is the one that makes persisted cursors unsafe, and the
 * reason this file exists.
 */

export const PAGE_SIZE = 15;

export class FakeBankingApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** FNV-1a. Any stable hash works; this one is short and dependency-free. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64');
}

export function decodeCursor(cursor: string): number {
  const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
  const offset = (parsed as { offset?: unknown }).offset;
  if (typeof offset !== 'number') throw new FakeBankingApiError(400, 'malformed cursor');
  return offset;
}

export interface PageResponse {
  transactions: BankingTransaction[];
  next_cursor: string | null;
}

export class FakeBankingApi {
  /** Pages served, per account — lets a test assert "we did not re-walk". */
  readonly pageRequests: string[] = [];

  /** When set, the Nth page request for this account throws. Simulates a crash. */
  private failures = new Map<string, number>();

  constructor(private readonly transactions: BankingTransaction[]) {}

  /** Make the (1-indexed) `pageNumber`-th request for this account fail. */
  failAccountAtPage(accountId: string, pageNumber: number): void {
    this.failures.set(accountId, pageNumber);
  }

  clearFailures(): void {
    this.failures.clear();
  }

  listTransactions(accountId: string, from?: string, to?: string, cursor?: string): PageResponse {
    if (!from || !to) throw new FakeBankingApiError(400, 'from and to query params required');

    const offset = cursor ? decodeCursor(cursor) : 0;
    const pageNumber = Math.floor(offset / PAGE_SIZE) + 1;

    this.pageRequests.push(`${accountId}:${from}:${to}:${String(offset)}`);
    if (this.failures.get(accountId) === pageNumber) {
      throw new FakeBankingApiError(
        503,
        `simulated upstream failure on page ${String(pageNumber)}`,
      );
    }

    // The query key seeds the ordering. Because `to` is part of it, widening
    // the range reshuffles everything — exactly as the real API does.
    const queryKey = `${accountId}|${from}|${to}`;
    const inRange = this.transactions
      .filter((t) => t.account_id === accountId && t.date >= from && t.date <= to)
      .sort((a, b) => hash(queryKey + a.id) - hash(queryKey + b.id));

    const page = inRange.slice(offset, offset + PAGE_SIZE);
    const nextOffset = offset + PAGE_SIZE;

    return {
      transactions: page,
      next_cursor: nextOffset < inRange.length ? encodeCursor(nextOffset) : null,
    };
  }

  /** Convenience: walk every page of a range, as a correct client would. */
  walkAll(accountId: string, from: string, to: string): BankingTransaction[] {
    const out: BankingTransaction[] = [];
    let cursor: string | undefined;
    do {
      const page = this.listTransactions(accountId, from, to, cursor);
      out.push(...page.transactions);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return out;
  }
}

/** Builds `count` transactions spread across a date range, deterministically. */
export function buildTransactions(accountId: string, count: number, startDate = '2025-09-01') {
  const start = Date.UTC(
    Number(startDate.slice(0, 4)),
    Number(startDate.slice(5, 7)) - 1,
    Number(startDate.slice(8, 10)),
  );
  return Array.from({ length: count }, (_, i): BankingTransaction => {
    const day = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    const credit = i % 7 === 0;
    return {
      // Namespaced: the real provider uses `txn_00000`-style ids, and a test
      // sharing a database with real data would otherwise upsert straight over it.
      id: `faketxn_${String(i).padStart(5, '0')}`,
      account_id: accountId,
      amount: credit ? 1200 : -Number((10 + (i % 40)).toFixed(2)),
      currency: 'EUR',
      date: day,
      description: credit ? 'SALARY' : 'PURCHASE',
      merchant_category_code: credit ? '9001' : '5411',
      merchant_name: credit ? 'Employer' : 'Supermarket',
      type: credit ? 'credit' : 'debit',
    };
  });
}
