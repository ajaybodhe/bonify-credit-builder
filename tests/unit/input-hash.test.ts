import { describe, expect, it } from 'vitest';
import {
  hashTransactionSet,
  type HistoricalTransaction,
} from '../../src/modules/reliability/reconstruct.js';

/**
 * `input_hash` is what turns a stored score into an auditable one: rebuild the
 * transaction set, re-hash it, and a match proves you are holding the inputs the
 * score was computed from.
 *
 * That only holds while the digest covers every field a score depends on. It
 * once omitted `account_id` and then `currency`, each of which can move a score
 * — so these pin the field list rather than any particular hash value.
 */
const base: HistoricalTransaction = {
  id: 't1',
  account_id: 'acc_a',
  user_id: 'u1',
  booked_at: '2025-10-05',
  amount: '-42.50',
  currency: 'EUR',
  description: 'Groceries',
  merchant: 'Supermarket',
  category: '5411',
  is_credit: false,
  status: 'active',
  content_hash: 'h',
  revision: 1,
};

const hashOf = (over: Partial<HistoricalTransaction> = {}) =>
  hashTransactionSet([{ ...base, ...over }]);

describe('hashTransactionSet covers every field that can change a score', () => {
  it.each([
    ['id', { id: 't2' }],
    ['account_id', { account_id: 'acc_b' }],
    ['booked_at', { booked_at: '2025-10-06' }],
    ['amount', { amount: '-99.99' }],
    ['currency', { currency: 'USD' }],
    ['category', { category: '7995' }],
    ['is_credit', { is_credit: true }],
  ])('a changed %s changes the hash', (_field, over) => {
    expect(hashOf(over)).not.toBe(hashOf());
  });

  /**
   * Deliberately outside the digest, matching `contentHashOf` on the ingest
   * side: upstream enriches descriptors without changing what the transaction
   * means, and no component reads either field.
   */
  it.each([
    ['description', { description: 'SUPERMARKET LTD 4471' }],
    ['merchant', { merchant: 'SUPERMARKET LTD' }],
  ])('a changed %s does NOT change the hash', (_field, over) => {
    expect(hashOf(over)).toBe(hashOf());
  });

  it('is order-independent, so two rebuilds of the same set agree', () => {
    const a: HistoricalTransaction = { ...base, id: 'a' };
    const b: HistoricalTransaction = { ...base, id: 'b' };
    expect(hashTransactionSet([a, b])).toBe(hashTransactionSet([b, a]));
  });
});
