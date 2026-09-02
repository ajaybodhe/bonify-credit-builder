import type { ScoredTransaction } from './scoring.js';

/**
 * Classifies movements between a user's own accounts, so they count as neither
 * income nor spending, and saving is credited only when money moves *into*
 * savings.
 *
 * **The provider reports an internal transfer as a SINGLE-SIDED credit** on the
 * receiving account — verified: `acc_1001_sav` has seven `6540` credits with no
 * matching debit anywhere in `acc_1001_chk`. So the risk is not double-counted
 * spending but phantom income: seven transfers would read as seven months of
 * income, and add €2,100 that never entered the household.
 *
 * Classification is by category group (the provider's marker) plus account type
 * (which gives direction):
 *
 *   credit into a `savings` account, transfer-coded   → SAVINGS, never income
 *   debit out of a `savings` account                  → DIS-SAVING, never spend
 *   any other own-account movement                    → ignored entirely
 *
 * Direction is the whole rule: savings → checking is the opposite of saving,
 * and checking → checking moves no money into or out of the household. Savings
 * is therefore scored on NET movement — save €500 and withdraw €500 and you
 * have saved nothing.
 *
 * Pair detection still runs as a safety net, in case a provider reports both
 * legs, and is deliberately strict: a false positive erases real income, so
 * missing a transfer is the better failure.
 */

/** Own-account transfers usually settle same-day; a small window covers weekends. */
export const MAX_SETTLEMENT_LAG_DAYS = 3;

export type AccountType = 'checking' | 'savings';

export interface TransferClassification {
  /** Must not count toward income (components A and B). */
  excludedFromIncome: ReadonlySet<string>;
  /** Must not count toward spending (components B, C and D's high-risk share). */
  excludedFromSpend: ReadonlySet<string>;
  /** Transaction ids moving money INTO a savings account. */
  savingsInIds: ReadonlySet<string>;
  /** Transaction ids moving money OUT of a savings account. */
  savingsOutIds: ReadonlySet<string>;
}

function absAmount(t: ScoredTransaction): string {
  return t.amount.replace('-', '');
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/**
 * Pure: transactions in, classification out. No database, no clock — so a score
 * stays reproducible from a stored snapshot.
 *
 * @param accountTypes  from `accounts.type`; an unknown account is treated as
 *                      checking, which is the conservative choice (it credits
 *                      no savings rather than inventing some).
 * @param savingsCategoryCodes  codes whose dictionary `group` is `savings`,
 *                      resolved dynamically — never hardcoded.
 */
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
        // Money arriving in savings. Whether it came from the user's own
        // checking account or straight from an employer, it is not spendable
        // household income arriving — and treating it as income is exactly the
        // bug this module exists to prevent.
        excludedFromIncome.add(t.id);
        savingsInIds.add(t.id);
      } else {
        // Money leaving savings: dis-saving, and not consumption either — the
        // consumption shows up separately on the account it lands in.
        excludedFromSpend.add(t.id);
        savingsOutIds.add(t.id);
      }
      continue;
    }

    // On a checking account, a transfer-coded DEBIT is money going to savings.
    // It is not consumption, so it must not inflate essential or total spend.
    // (In the current provider this leg is absent, but a provider that emits it
    // must not have it counted as spending.)
    if (isTransferCoded && !t.isCredit) {
      excludedFromSpend.add(t.id);
      savingsInIds.add(t.id);
      continue;
    }

    // A transfer-coded CREDIT into checking is money coming back out of
    // savings — never income.
    if (isTransferCoded && t.isCredit) {
      excludedFromIncome.add(t.id);
      savingsOutIds.add(t.id);
    }
  }

  // Safety net for double-entry providers: an unmatched credit leg would
  // otherwise be counted as income.
  detectPairs(transactions, excludedFromIncome, excludedFromSpend);

  return { excludedFromIncome, excludedFromSpend, savingsInIds, savingsOutIds };
}

/**
 * Strict pair matching: exact opposite amount, different accounts of the same
 * user, within the settlement window, each transaction consumed at most once.
 * Mutates the exclusion sets, since a matched pair is by definition neither
 * income nor spend.
 */
function detectPairs(
  transactions: readonly ScoredTransaction[],
  excludedFromIncome: Set<string>,
  excludedFromSpend: Set<string>,
): void {
  const creditsByAmount = new Map<string, ScoredTransaction[]>();
  for (const t of transactions) {
    if (!t.isCredit) continue;
    const key = absAmount(t);
    const bucket = creditsByAmount.get(key);
    if (bucket) bucket.push(t);
    else creditsByAmount.set(key, [t]);
  }

  const debits = transactions
    .filter((t) => !t.isCredit)
    // Deterministic order so the same input always yields the same pairing.
    .sort((a, b) =>
      a.bookedAt === b.bookedAt ? a.id.localeCompare(b.id) : a.bookedAt.localeCompare(b.bookedAt),
    );

  const consumedCredits = new Set<string>();

  for (const debit of debits) {
    const match = (creditsByAmount.get(absAmount(debit)) ?? [])
      .filter(
        (c) =>
          !consumedCredits.has(c.id) &&
          c.accountId !== debit.accountId &&
          c.userId === debit.userId &&
          daysBetween(c.bookedAt, debit.bookedAt) <= MAX_SETTLEMENT_LAG_DAYS,
      )
      .sort((a, b) => {
        const d = daysBetween(a.bookedAt, debit.bookedAt) - daysBetween(b.bookedAt, debit.bookedAt);
        return d !== 0 ? d : a.id.localeCompare(b.id);
      })[0];

    if (!match) continue;

    consumedCredits.add(match.id);
    excludedFromIncome.add(match.id);
    excludedFromSpend.add(debit.id);
  }
}
