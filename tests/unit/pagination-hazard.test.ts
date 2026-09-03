import { describe, expect, it } from 'vitest';
import {
  FakeBankingApi,
  buildTransactions,
  encodeCursor,
  PAGE_SIZE,
} from '../helpers/fake-banking-api.js';

/**
 * These tests are the executable form of the decision recorded in
 * docs/architecture-design.md §4.5: **resume by date range, never by cursor.**
 *
 * They serve two purposes.
 *
 * 1. They pin the behaviour of the test double, so the e2e suite built on it is
 *    trustworthy. A fake that returned tidy date-ordered pages would let a
 *    cursor-resuming implementation pass everything and still lose data in
 *    production.
 * 2. The last block DEMONSTRATES the data loss, rather than asserting it in
 *    prose. If someone later "optimises" sync by persisting a cursor, this is
 *    the test that explains why not.
 */

const ACCOUNT = 'acc_test_chk';
const ALL = buildTransactions(ACCOUNT, 100); // 2025-09-01 .. 2025-12-09

describe('pagination behaves the way the upstream actually behaves', () => {
  it('puts DIFFERENT rows at the same offset when `to` changes', () => {
    const api = new FakeBankingApi(ALL);
    const cursor = encodeCursor(PAGE_SIZE);
    const narrow = api.listTransactions(ACCOUNT, '2025-09-01', '2025-10-31', cursor);
    const wide = api.listTransactions(ACCOUNT, '2025-09-01', '2025-12-31', cursor);
    expect(narrow.transactions.map((t) => t.id)).not.toEqual(wide.transactions.map((t) => t.id));
  });
});

describe('WHY we must not persist a cursor across runs', () => {
  /**
   * The scenario, concretely:
   *   Run 1 syncs 2025-09-01..2025-10-31, dies after 2 pages, stores offset 30.
   *   Run 2 happens a day later, so `to` has moved to 2025-12-31, and naively
   *   resumes from offset 30.
   *
   * Because the wider range is ordered differently, offset 30 is a different
   * place in a different list. Rows are skipped, and dedupe never notices —
   * dedupe only sees rows it is handed.
   */
  it('resuming a stored offset after `to` moves SKIPS transactions', () => {
    const api = new FakeBankingApi(ALL);

    // Run 1: partial walk of the narrow range.
    const collected = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 2; page++) {
      const res = api.listTransactions(ACCOUNT, '2025-09-01', '2025-10-31', cursor);
      res.transactions.forEach((t) => collected.add(t.id));
      cursor = res.next_cursor ?? undefined;
    }
    expect(collected.size).toBe(30);
    expect(cursor).toBe(encodeCursor(30));

    // Run 2: same stored cursor, but the range has widened.
    let c: string | undefined = cursor;
    do {
      const res = api.listTransactions(ACCOUNT, '2025-09-01', '2025-12-31', c);
      res.transactions.forEach((t) => collected.add(t.id));
      c = res.next_cursor ?? undefined;
    } while (c);

    // The first 30 rows of the WIDE ordering were never fetched by either run.
    const missing = ALL.filter((t) => !collected.has(t.id));
    expect(missing.length).toBeGreaterThan(0);

    // And the gap is invisible: every row we DID store is valid and deduped.
    // Nothing in the data says anything is absent. That is the whole hazard.
  });

  it('re-fetching the range by date instead loses nothing', () => {
    const api = new FakeBankingApi(ALL);

    // Run 1 dies part-way; whatever it collected is kept.
    const collected = new Set<string>();
    const partial = api.listTransactions(ACCOUNT, '2025-09-01', '2025-10-31');
    partial.transactions.forEach((t) => collected.add(t.id));

    // Run 2 re-walks the full range from the last CONFIRMED-complete date.
    // Overlap is free: dedupe collapses it.
    api.walkAll(ACCOUNT, '2025-09-01', '2025-12-31').forEach((t) => collected.add(t.id));

    expect(collected.size).toBe(ALL.length);
    expect(ALL.every((t) => collected.has(t.id))).toBe(true);
  });
});
