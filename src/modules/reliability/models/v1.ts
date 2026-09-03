import type { ScoringWindow } from '../../../lib/date.js';
import type { Metrics, ScoreBand } from '../schemas.js';
import type { ScoreComponents, ScoringInput, ScoringResult } from '../scoring.js';

/**
 * Reliability Index — model version 1. FROZEN: any change to a constant or to
 * the logic is a new version in a new file, never an edit here, which is what
 * lets `model_version` alone identify how a past score was produced. Hence also
 * self-contained — `clamp`, `interpolate` and `bandFor` live here, so a later
 * version cannot change v1 from underneath. Constants: docs/scoring-model.md.
 */

export const VERSION = 1;

/** Typed outside `MODEL`, or `as const` narrows these and the checks go dead. */
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
   * B) Income coverage — piecewise-linear (ratio, points), clamped at both ends.
   * Full marks are NOT at break-even: covering essentials exactly leaves nothing
   * for a missed paycheque, so 1.0x earns roughly half. Returns flatten above
   * 2.0x, where 3x versus 5x mostly says "not thin-file".
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
     * NET movement into savings over income — a rate, not an amount. Net, because
     * saving €500 and withdrawing €500 is not saving; a rate, because absolute
     * euros would just proxy income level, which A and B already measure.
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
   * Undefined in the brief. Here: a month with income AND an essential payment
   * AND no fee event. Reported, never scored, so it cannot double-count A-D.
   */
  goodMonth: GOOD_MONTH,

  bands: { mediumFrom: 50, highFrom: 75 },
} as const;

/** Integer cents inside the model; a decimal string everywhere else. */
function cents(amount: string): number {
  return Math.round(Number(amount) * 100);
}

const yearMonth = (isoDate: string): string => isoDate.slice(0, 7);

export function computeReliabilityIndex(input: ScoringInput): ScoringResult {
  const { window, transactions, transfers, categories, closingBalances } = input;

  const active = transactions.filter((t) => t.status === 'active');

  const isIncome = (t: (typeof active)[number]) =>
    t.isCredit &&
    !transfers.excludedFromIncome.has(t.id) &&
    // The brief: a month has income if a transaction is categorised income "or is a
    // credit". A bare credit counts because thin-file users are paid irregularly.
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

  // Undefined, not infinite — a DATA gap must never read as a perfect score, so it
  // is pinned to break-even and one `interpolate` call covers both cases.
  const coverageUndefined = totalEssential === 0;
  const coverageRatio = coverageUndefined ? 1 : totalIncome / totalEssential;
  const pointsB = interpolate(coverageRatio, MODEL.incomeCoverage.breakpoints);

  // The denominator is every essential category the dictionary defines, not only
  // those this applicant used — the model's sharpest fairness weakness, see docs.
  const essentialCategoryMonths = new Set(
    active
      .filter((t) => isSpend(t) && inGroup(t, categories.essential))
      .map((t) => `${t.category ?? ''}:${yearMonth(t.bookedAt)}`),
  );
  const possibleCategoryMonths = window.months.length * categories.essential.length;
  const essentialConsistency =
    possibleCategoryMonths === 0 ? 0 : essentialCategoryMonths.size / possibleCategoryMonths;
  const pointsC = Math.round(essentialConsistency * MODEL.essentialConsistency.maxPoints);

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

  // Debits only: a `fees` credit is the bank REFUNDING a charge, and counting it
  // would penalise the applicant for the fee being reversed in their favour.
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

  // Reported, never scored: it reuses signals A, C and D already use.
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
 * Days on which any account closed negative. The provider exposes one balance
 * and a history, never a balance series, so the series is walked backwards:
 * `balance_before = balance_after − amount`. A quiet day carries the previous
 * balance forward — being overdrawn on a Sunday still counts.
 *
 * The anchor is the provider's balance at `window.end`, NOT rolled back over
 * later movement, because it cannot be reconciled with the published
 * transactions. Every day here is therefore an estimate, which is why the
 * caller caps the term.
 */
function estimateNegativeBalanceDays(
  transactions: readonly { accountId: string; bookedAt: string; amount: string }[],
  closingBalances: Readonly<Record<string, string>>,
  window: ScoringWindow,
): number {
  const negativeDays = new Set<string>();

  /** One pass: scanning per account costs accounts × transactions. */
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
 * Ordered by impact. From docs/scoring-model.md: state the evidence, not the
 * arithmetic; include the penalties, because a score is not explained if only
 * the good news appears; never phrase a driver as a judgement about the person.
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
  // Half a percent, not zero: a driver that rounds to "0%" says nothing.
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
