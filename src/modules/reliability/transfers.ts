import type { ScoredTransaction } from './scoring.js';

/**
 * Classifies movements between a user's own accounts, so they are neither income
 * nor spending, and saving is credited only on money moving *into* savings.
 * The provider reports an internal transfer as a SINGLE-SIDED credit on the
 * receiving account — verified against live provider data — so the risk is phantom
 * income and there is no second leg to link:
 *   credit into a `savings` account   → SAVINGS, never income
 *   debit out of a `savings` account  → DIS-SAVING, never spend
 *   anything else                     → not identified, counted normally
 * Account type alone decides the first two, which is what makes identification
 * possible without linkage. No amount-and-date pair matching: it can only guess
 * wrongly in the expensive direction. See docs/scoring-model.md.
 */

export type AccountType = 'checking' | 'savings';

export interface TransferClassification {
  excludedFromIncome: ReadonlySet<string>;
  excludedFromSpend: ReadonlySet<string>;
  savingsInIds: ReadonlySet<string>;
  savingsOutIds: ReadonlySet<string>;
}

/** Pure. An unknown account is treated as checking: it credits no savings. */
export function classifyTransfers(
  transactions: readonly ScoredTransaction[],
  accountTypes: ReadonlyMap<string, AccountType>,
  savingsCategoryCodes: ReadonlySet<string>,
): TransferClassification {
  const excludedFromIncome = new Set<string>();
  const excludedFromSpend = new Set<string>();
  const savingsInIds = new Set<string>();
  const savingsOutIds = new Set<string>();

  for (const t of transactions) {
    const accountType = accountTypes.get(t.accountId) ?? 'checking';
    const isTransferCoded = t.category !== null && savingsCategoryCodes.has(t.category);

    if (accountType === 'savings') {
      if (t.isCredit) {
        excludedFromIncome.add(t.id);
        savingsInIds.add(t.id);
      } else {
        excludedFromSpend.add(t.id);
        savingsOutIds.add(t.id);
      }
      continue;
    }

    if (isTransferCoded && !t.isCredit) {
      excludedFromSpend.add(t.id);
      savingsInIds.add(t.id);
      continue;
    }

    if (isTransferCoded && t.isCredit) {
      excludedFromIncome.add(t.id);
      savingsOutIds.add(t.id);
    }
  }

  return { excludedFromIncome, excludedFromSpend, savingsInIds, savingsOutIds };
}
