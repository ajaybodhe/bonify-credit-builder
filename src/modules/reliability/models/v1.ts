import type { ScoringWindow } from '../../../lib/date.js';
import type { Metrics, ScoreBand } from '../schemas.js';
import type { ScoreComponents, ScoringInput, ScoringResult } from '../scoring.js';

/**
 * Reliability Index — model **version 1**.
 *
 * ## This file is frozen once released
 *
 * A model version is immutable. Any change to a constant or to the logic —
 * however small — is a NEW version in a new file, never an edit here. That is
 * what lets `score_snapshots.model_version` alone identify how a past score was
 * produced, with nothing about the model copied into the row.
 *
 * `tests/unit/model-versions.test.ts` enforces it: a frozen version's file is
 * hashed, and editing it fails the build with instructions to add the next
 * version instead.
 *
 * Because of that, this file is deliberately **self-contained**. Helpers that
 * affect the output — `clamp`, `interpolate`, `bandFor` — live here rather than
 * being shared, so a later version cannot change v1's behaviour by changing
 * something underneath it.
 *
 * Rationale for every constant: docs/scoring-model.md.
 */

export const VERSION = 1;

/**
 * Declared outside `MODEL` and explicitly typed `boolean`, so `as const` does
 * not narrow these to literals. Narrowed, the compiler would prove the checks
 * in `computeReliabilityIndex` dead and the constants would become decorative —
 * changing one would no longer change behaviour.
 */
const GOOD_MONTH: {
  requiresIncome: boolean;
  requiresEssentialPayment: boolean;
  allowsFeeEvents: boolean;
} = {
  requiresIncome: true,
  requiresEssentialPayment: true,
  allowsFeeEvents: false,
};

export const MODEL = {
  /** A) Income regularity — linear, 0..25 for 0..6 months with income. */
  incomeRegularity: { maxPoints: 25 },

  /**
   * B) Income coverage ratio — piecewise-linear with diminishing returns.
   *
   * The brief leaves this mapping open. Chosen shape: full marks are NOT at
   * break-even. Covering essentials exactly (1.0x) leaves nothing for a missed
   * paycheque, so 1.0x earns roughly half. Returns flatten above 2.0x because
   * the difference between a 3x and a 5x earner says little about reliability
   * — it mostly says they are not thin-file.
   *
   * Breakpoints are (ratio, points), linearly interpolated between them and
   * clamped at both ends.
   */
  incomeCoverage: {
    maxPoints: 25,
    breakpoints: [
      [0.0, 0],
      [0.8, 6],
      [1.0, 12],
      [1.25, 18],
      [1.5, 21],
      [2.0, 24],
      [3.0, 25],
    ] as const satisfies readonly (readonly [number, number])[],
  },

  /** C) Essential payments consistency — linear, 0..25. */
  essentialConsistency: { maxPoints: 25 },

  /** D) Resilience adjustments, summed then clamped to [-20, +25]. */
  resilience: {
    min: -20,
    max: 25,
    /**
     * Savings: NET movement into savings (inflows minus outflows, floored at
     * zero) divided by total income over the window — a rate, not an amount.
     *
     * Net, because a user who saves €500 and withdraws €500 has saved nothing;
     * counting inflows alone would make them look like a saver. A rate, because
     * €200/month on €1,200 income is a far stronger signal than €200/month on
     * €6,000 — and using absolute euros would turn this into a proxy for income
     * level, which A and B already measure.
     */
    savings: { maxPoints: 25, fullCreditRate: 0.15 },
    /** Negative balance days: 0 days = 0, 30+ days = full penalty. */
    negativeBalance: { maxPenalty: -10, fullPenaltyDays: 30 },
    /** Late fees: -1.25 per event, floored at -5 (i.e. 4+ events saturate). */
    lateFees: { maxPenalty: -5, penaltyPerEvent: -1.25 },
    /** High-risk spend as a share of total spend; 20%+ saturates the penalty. */
    highRisk: { maxPenalty: -5, fullPenaltyShare: 0.2 },
  },

  /**
   * `good_months` appears in the brief's example response but the brief never
   * defines it, and neither did this model — it was in the contract with no
   * computation behind it.
   *
   * Defined here as: a month within the window that has income AND at least one
   * essential payment AND no fee event. That is the plain reading of "a month
   * that went well", it uses only signals the other components already
   * establish, and it is reported as a metric rather than scored — nothing in
   * A-D depends on it, so it adds explanatory value without double-counting.
   */
  goodMonth: GOOD_MONTH,

  bands: { mediumFrom: 50, highFrom: 75 },
} as const;

/** Money is a decimal string everywhere else; inside the model it is integer cents. */
function cents(amount: string): number {
  return Math.round(Number(amount) * 100);
}

const yearMonth = (isoDate: string): string => isoDate.slice(0, 7);

export function computeReliabilityIndex(input: ScoringInput): ScoringResult {
  const { window, transactions, transfers, categories, closingBalances } = input;

  // Amended and reversed rows are retained for audit but must never score.
  const active = transactions.filter((t) => t.status === 'active');

  const isIncome = (t: (typeof active)[number]) =>
    t.isCredit &&
    !transfers.excludedFromIncome.has(t.id) &&
    // The brief: a month has income if a transaction is categorised income
    // "or is a credit". Categorised income is the stronger signal; a bare
    // credit counts because thin-file users are often paid irregularly.
    (t.category === null || !categories.savings.includes(t.category));

  const isSpend = (t: (typeof active)[number]) =>
    !t.isCredit && !transfers.excludedFromSpend.has(t.id);

  const inGroup = (t: (typeof active)[number], group: readonly string[]) =>
    t.category !== null && group.includes(t.category);

  // ---- A. Income regularity ------------------------------------------------
  const monthsWithIncome = new Set(active.filter(isIncome).map((t) => yearMonth(t.bookedAt)));
  const incomeRegularity = monthsWithIncome.size / window.months.length;
  const pointsA = Math.round(incomeRegularity * MODEL.incomeRegularity.maxPoints);

  // ---- B. Income coverage --------------------------------------------------
  const totalIncome = active
    .filter(isIncome)
    .reduce((sum, t) => sum + Math.abs(cents(t.amount)), 0);
  const totalEssential = active
    .filter((t) => isSpend(t) && inGroup(t, categories.essential))
    .reduce((sum, t) => sum + Math.abs(cents(t.amount)), 0);

  // Zero essential spend makes the ratio undefined, not infinite. That is a
  // DATA gap, and a data gap must never read as a perfect score — so it is
  // awarded the break-even value rather than the maximum.
  const coverageUndefined = totalEssential === 0;
  const coverageRatio = coverageUndefined ? 1 : totalIncome / totalEssential;
  // `coverageRatio` is already pinned to 1 when the denominator is zero, so one
  // call covers both cases — a data gap scores the break-even value, never full
  // marks. The branch this replaces had two identical arms.
  const pointsB = interpolate(coverageRatio, MODEL.incomeCoverage.breakpoints);

  // ---- C. Essential payments consistency -----------------------------------
  // The denominator is every essential category the dictionary defines, not
  // only those this applicant used. That is deliberate and is the model's
  // sharpest fairness weakness — see docs/scoring-model.md.
  const essentialCategoryMonths = new Set(
    active
      .filter((t) => isSpend(t) && inGroup(t, categories.essential))
      .map((t) => `${t.category ?? ''}:${yearMonth(t.bookedAt)}`),
  );
  const possibleCategoryMonths = window.months.length * categories.essential.length;
  const essentialConsistency =
    possibleCategoryMonths === 0 ? 0 : essentialCategoryMonths.size / possibleCategoryMonths;
  const pointsC = Math.round(essentialConsistency * MODEL.essentialConsistency.maxPoints);

  // ---- D. Resilience -------------------------------------------------------
  // Savings is a NET rate: money moved in minus money taken back out, over
  // income. €500 saved and €500 withdrawn is not saving.
  const savingsIn = active
    .filter((t) => transfers.savingsInIds.has(t.id))
    .reduce((sum, t) => sum + Math.abs(cents(t.amount)), 0);
  const savingsOut = active
    .filter((t) => transfers.savingsOutIds.has(t.id))
    .reduce((sum, t) => sum + Math.abs(cents(t.amount)), 0);
  const netSavings = Math.max(0, savingsIn - savingsOut);
  const savingsRate = totalIncome === 0 ? 0 : netSavings / totalIncome;
  const savingsPoints =
    Math.min(1, savingsRate / MODEL.resilience.savings.fullCreditRate) *
    MODEL.resilience.savings.maxPoints;

  const negativeBalanceDays = estimateNegativeBalanceDays(active, closingBalances, window);
  const negativeBalancePoints =
    Math.min(1, negativeBalanceDays / MODEL.resilience.negativeBalance.fullPenaltyDays) *
    MODEL.resilience.negativeBalance.maxPenalty;

  // Debits only. A `fees` credit is the bank REFUNDING a charge — counting it
  // would penalise the applicant twice for one fee and, worse, penalise them
  // for the fee being reversed in their favour.
  const feeEvents = active.filter((t) => !t.isCredit && inGroup(t, categories.fees)).length;
  const lateFeePoints = Math.max(
    MODEL.resilience.lateFees.maxPenalty,
    feeEvents * MODEL.resilience.lateFees.penaltyPerEvent,
  );

  const totalSpend = active.filter(isSpend).reduce((sum, t) => sum + Math.abs(cents(t.amount)), 0);
  const highRiskSpend = active
    .filter((t) => isSpend(t) && inGroup(t, categories.highRisk))
    .reduce((sum, t) => sum + Math.abs(cents(t.amount)), 0);
  const highRiskShare = totalSpend === 0 ? 0 : highRiskSpend / totalSpend;
  const highRiskPoints =
    Math.min(1, highRiskShare / MODEL.resilience.highRisk.fullPenaltyShare) *
    MODEL.resilience.highRisk.maxPenalty;

  const pointsD = clamp(
    savingsPoints + negativeBalancePoints + lateFeePoints + highRiskPoints,
    MODEL.resilience.min,
    MODEL.resilience.max,
  );

  // ---- good_months ---------------------------------------------------------
  // Reported, never scored: it reuses signals A, C and D already use, so
  // letting it move the index would count the same facts twice.
  const monthsWithEssential = new Set(
    active
      .filter((t) => isSpend(t) && inGroup(t, categories.essential))
      .map((t) => yearMonth(t.bookedAt)),
  );
  const monthsWithFees = new Set(
    active.filter((t) => inGroup(t, categories.fees)).map((t) => yearMonth(t.bookedAt)),
  );
  const goodMonths = window.months.filter(
    (m) =>
      (!MODEL.goodMonth.requiresIncome || monthsWithIncome.has(m)) &&
      (!MODEL.goodMonth.requiresEssentialPayment || monthsWithEssential.has(m)) &&
      (MODEL.goodMonth.allowsFeeEvents || !monthsWithFees.has(m)),
  ).length;

  const index = clamp(Math.round(pointsA + pointsB + pointsC + pointsD), 0, 100);

  const components: ScoreComponents = {
    income_regularity_points: pointsA,
    income_coverage_points: round2(pointsB),
    essential_consistency_points: pointsC,
    resilience_points: round2(pointsD),
    resilience_breakdown: {
      savings: round2(savingsPoints),
      negative_balance: round2(negativeBalancePoints),
      late_fees: round2(lateFeePoints),
      high_risk: round2(highRiskPoints),
    },
    transfers_excluded_from_income: transfers.excludedFromIncome.size,
    net_savings: (netSavings / 100).toFixed(2),
  };

  const metrics: Metrics = {
    income_regularity: round2(incomeRegularity),
    income_coverage_ratio: round2(coverageRatio),
    essential_payments_consistency: round2(essentialConsistency),
    good_months: goodMonths,
    negative_balance_days: negativeBalanceDays,
    late_fee_events: feeEvents,
  };

  return {
    model_version: VERSION,
    reliability_index: index,
    score_band: bandFor(index),
    metrics,
    components,
    drivers: buildDrivers({
      monthsWithIncome: monthsWithIncome.size,
      totalMonths: window.months.length,
      coverageRatio,
      coverageUndefined,
      essentialCategoryMonths: essentialCategoryMonths.size,
      possibleCategoryMonths,
      savingsRate,
      negativeBalanceDays,
      feeEvents,
      highRiskShare,
      transfersExcluded: transfers.excludedFromIncome.size,
    }),
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Days on which any account carried a negative closing balance.
 *
 * The provider exposes a single balance and a transaction history, never a
 * historical balance series, so the series is reconstructed by walking
 * backwards: `balance_before = balance_after − amount`. Amounts are signed, so
 * that one expression undoes a credit and restores a debit alike.
 *
 * Days with no activity carry the previous day's balance forward, because being
 * overdrawn on a quiet Sunday still counts.
 *
 * ## Why the penalty is capped
 *
 * The reconstruction is only as sound as its ANCHOR. Callers pass the provider's
 * reported balance as it stands at `window.end`, WITHOUT rolling later movement
 * back off it: this provider's balance cannot be reconciled with the
 * transactions it publishes, so rolling back makes the series worse, not better.
 * See `docs/scoring-model.md`.
 *
 * That makes every day here an estimate rather than an observation, which is why
 * the caller caps this term at `MODEL.resilience.negativeBalance.maxPenalty`. An
 * inferred signal must not move a score as far as a counted one.
 */
function estimateNegativeBalanceDays(
  transactions: readonly { accountId: string; bookedAt: string; amount: string }[],
  closingBalances: Readonly<Record<string, string>>,
  window: ScoringWindow,
): number {
  const negativeDays = new Set<string>();

  /**
   * Net movement per account per day, built in ONE pass.
   *
   * The obvious shape — a fresh scan of every transaction inside the per-account
   * loop — re-reads the whole list once per account, so cost grows with
   * accounts × transactions for data that is already in memory. Bucketing first
   * makes it one pass plus a constant-time lookup per day walked.
   */
  const movements = new Map<string, Map<string, number>>();
  for (const t of transactions) {
    let perDay = movements.get(t.accountId);
    if (perDay === undefined) {
      perDay = new Map<string, number>();
      movements.set(t.accountId, perDay);
    }
    perDay.set(t.bookedAt, (perDay.get(t.bookedAt) ?? 0) + cents(t.amount));
  }

  for (const [accountId, closing] of Object.entries(closingBalances)) {
    // The walk steps one day at a time so every day records its CLOSING
    // balance — including the first day of the window.
    const movement = movements.get(accountId);

    let balance = cents(closing);
    let cursor = window.end;
    while (cursor >= window.start) {
      if (balance < 0) negativeDays.add(cursor);
      balance -= movement?.get(cursor) ?? 0;
      cursor = previousDay(cursor);
    }
  }

  return negativeDays.size;
}

function previousDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Human-readable explanations, ordered by impact.
 *
 * Rules, from docs/scoring-model.md: state the evidence and not the arithmetic;
 * include the penalties, because a score is not explained if only the good news
 * appears; and never phrase a driver as a judgement about the person.
 */
function buildDrivers(f: {
  monthsWithIncome: number;
  totalMonths: number;
  coverageRatio: number;
  coverageUndefined: boolean;
  essentialCategoryMonths: number;
  possibleCategoryMonths: number;
  savingsRate: number;
  negativeBalanceDays: number;
  feeEvents: number;
  highRiskShare: number;
  transfersExcluded: number;
}): string[] {
  const drivers: string[] = [
    `Income present in ${String(f.monthsWithIncome)}/${String(f.totalMonths)} months`,
  ];

  drivers.push(
    f.coverageUndefined
      ? 'No essential spending observed, so income coverage could not be measured — scored as break-even rather than as a perfect result'
      : `Income covers essential expenses (${f.coverageRatio.toFixed(2)}x)`,
  );

  drivers.push(
    `Essential payments seen in ${String(f.essentialCategoryMonths)}/${String(
      f.possibleCategoryMonths,
    )} category-months`,
  );

  if (f.savingsRate > 0) {
    drivers.push(`Saved ${(f.savingsRate * 100).toFixed(0)}% of income, net of withdrawals`);
  }
  if (f.negativeBalanceDays > 0) {
    drivers.push(
      `${String(f.negativeBalanceDays)} days with an estimated negative balance (reconstructed from the closing balance, not observed)`,
    );
  }
  if (f.feeEvents > 0) {
    drivers.push(`${String(f.feeEvents)} fee event${f.feeEvents === 1 ? '' : 's'}`);
  }
  // Guarded at half a percent, not zero: a share that rounds to "0%" is noise
  // in an explanation, and a driver that says nothing costs the reader trust in
  // the ones that do.
  if (f.highRiskShare >= 0.005) {
    drivers.push(`${(f.highRiskShare * 100).toFixed(0)}% of spending in high-risk categories`);
  }
  if (f.transfersExcluded > 0) {
    drivers.push(
      `${String(f.transfersExcluded)} own-account transfer${
        f.transfersExcluded === 1 ? '' : 's'
      } excluded from income`,
    );
  }

  return drivers;
}

export function bandFor(score: number): ScoreBand {
  if (score >= MODEL.bands.highFrom) return 'HIGH';
  if (score >= MODEL.bands.mediumFrom) return 'MEDIUM';
  return 'LOW';
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Linear interpolation across the coverage breakpoints, clamped at both ends.
 * Exported separately because it is the single piece of B most worth a
 * table-driven test.
 */
export function interpolate(x: number, points: readonly (readonly [number, number])[]): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) throw new Error('interpolate needs at least one breakpoint');
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];

  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i];
    const hi = points[i + 1];
    if (!lo || !hi) continue;
    if (x >= lo[0] && x <= hi[0]) {
      const span = hi[0] - lo[0];
      if (span === 0) return lo[1];
      return lo[1] + ((x - lo[0]) / span) * (hi[1] - lo[1]);
    }
  }
  return last[1];
}
