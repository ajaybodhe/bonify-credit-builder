import { describe, expect, it } from 'vitest';
import {
  MODEL,
  bandFor,
  clamp,
  computeReliabilityIndex,
  interpolate,
} from '../../src/modules/reliability/models/v1.js';
import type { ScoringWindow } from '../../src/lib/date.js';
import type { Transaction } from '../../src/db/schema.js';
import type { TransferClassification } from '../../src/modules/reliability/transfers.js';

/**
 * Every number `docs/scoring-model.md` publishes, asserted against `MODEL`.
 *
 * The frozen-digest test in `model-versions.test.ts` guards a released model
 * file against edits — a different thing. It says nothing about whether the
 * document still describes the code, so without this a constant could change
 * and every test would still pass while the doc quietly became fiction.
 *
 * A failure here means one of two edits is missing, not that the number is
 * wrong: change both, in the same commit.
 */
describe('the documented constants match MODEL', () => {
  it('bands: LOW 0-49, MEDIUM 50-74, HIGH 75-100', () => {
    expect(MODEL.bands).toEqual({ mediumFrom: 50, highFrom: 75 });
  });

  it('components A, B and C are worth 25 points each', () => {
    expect(MODEL.incomeRegularity.maxPoints).toBe(25);
    expect(MODEL.incomeCoverage.maxPoints).toBe(25);
    expect(MODEL.essentialConsistency.maxPoints).toBe(25);
  });

  it('the coverage curve has the published breakpoints', () => {
    expect(MODEL.incomeCoverage.breakpoints).toEqual([
      [0.0, 0],
      [0.8, 6],
      [1.0, 12],
      [1.25, 18],
      [1.5, 21],
      [2.0, 24],
      [3.0, 25],
    ]);
  });

  it('resilience spans -20 to +25', () => {
    expect(MODEL.resilience.min).toBe(-20);
    expect(MODEL.resilience.max).toBe(25);
  });

  it('resilience sub-signals use the published mappings', () => {
    expect(MODEL.resilience.savings).toEqual({ maxPoints: 25, fullCreditRate: 0.15 });
    expect(MODEL.resilience.negativeBalance).toEqual({ maxPenalty: -10, fullPenaltyDays: 30 });
    expect(MODEL.resilience.lateFees).toEqual({ maxPenalty: -5, penaltyPerEvent: -1.25 });
    expect(MODEL.resilience.highRisk).toEqual({ maxPenalty: -5, fullPenaltyShare: 0.2 });
  });

  it('a good month needs income, an essential payment, and no fee', () => {
    expect(MODEL.goodMonth).toEqual({
      requiresIncome: true,
      requiresEssentialPayment: true,
      allowsFeeEvents: false,
    });
  });
});

describe('bandFor', () => {
  it.each([
    [0, 'LOW'],
    [49, 'LOW'],
    [50, 'MEDIUM'],
    [74, 'MEDIUM'],
    [75, 'HIGH'],
    [100, 'HIGH'],
  ])('scores %i as %s', (score, band) => {
    expect(bandFor(score)).toBe(band);
  });
});

describe('clamp', () => {
  it('bounds on both sides', () => {
    expect(clamp(-5, 0, 100)).toBe(0);
    expect(clamp(150, 0, 100)).toBe(100);
    expect(clamp(64, 0, 100)).toBe(64);
  });
});

describe('interpolate — income coverage curve', () => {
  const bp = MODEL.incomeCoverage.breakpoints;

  it('returns 0 points at 0x coverage', () => {
    expect(interpolate(0, bp)).toBe(0);
  });

  it('awards about half marks at break-even, not full', () => {
    // Break-even is the edge of resilience, not resilience.
    expect(interpolate(1, bp)).toBe(12);
    expect(interpolate(1, bp)).toBeLessThan(MODEL.incomeCoverage.maxPoints / 2 + 1);
  });

  it('never decreases as coverage rises', () => {
    let previous = -1;
    for (let x = 0; x <= 4; x += 0.05) {
      const y = interpolate(x, bp);
      expect(y).toBeGreaterThanOrEqual(previous);
      previous = y;
    }
  });

  it('saturates above 3x rather than growing without bound', () => {
    expect(interpolate(3, bp)).toBe(MODEL.incomeCoverage.maxPoints);
    expect(interpolate(50, bp)).toBe(MODEL.incomeCoverage.maxPoints);
  });

  it('clamps below the first breakpoint', () => {
    expect(interpolate(-5, bp)).toBe(0);
  });
});

describe('computeReliabilityIndex', () => {
  const WINDOW: ScoringWindow = {
    start: '2025-09-01',
    end: '2026-02-20',
    months: ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02'],
  };

  const CATEGORIES = {
    version: 1,
    essential: ['5411', '6513'],
    highRisk: ['7995'],
    savings: ['6540'],
    income: ['9001'],
    fees: ['6012'],
    fetchedAt: new Date('2026-02-21T00:00:00Z'),
    stale: false,
    source: 'database' as const,
  };

  const NO_TRANSFERS: TransferClassification = {
    excludedFromIncome: new Set<string>(),
    excludedFromSpend: new Set<string>(),
    savingsInIds: new Set<string>(),
    savingsOutIds: new Set<string>(),
  };

  let seq = 0;
  const txn = (
    bookedAt: string,
    amount: string,
    category: string,
    opts: { credit?: boolean; status?: string } = {},
  ) =>
    ({
      id: `t${String(++seq)}`,
      accountId: 'acc',
      userId: 'u',
      bookedAt,
      amount,
      currency: 'EUR',
      description: null,
      merchant: null,
      category,
      isCredit: opts.credit ?? false,
      status: opts.status ?? 'active',
      contentHash: 'h',
      revision: 1,
    }) as unknown as Transaction;

  const run = (
    transactions: Transaction[],
    closingBalances: Record<string, string> = { acc: '500.00' },
  ) =>
    computeReliabilityIndex({
      window: WINDOW,
      transactions,
      transfers: NO_TRANSFERS,
      categories: CATEGORIES,
      closingBalances,
    });

  /** Salary every month, rent every month — the shape the model is built to reward. */
  const steady = () =>
    WINDOW.months.flatMap((m) => [
      txn(`${m}-01`, '2000.00', '9001', { credit: true }),
      txn(`${m}-05`, '-800.00', '6513'),
      txn(`${m}-09`, '-200.00', '5411'),
    ]);

  /** €2,000 in and €1,000 of essentials out, every month, ending solvent. */
  it('scores a steady solvent earner near the top, with reasons attached', () => {
    const r = run(steady(), { acc: '6500.00' });
    expect(r.metrics.income_regularity).toBe(1);
    expect(r.metrics.good_months).toBe(6);
    expect(r.metrics.income_coverage_ratio).toBe(2);
    expect(r.metrics.negative_balance_days).toBe(0);
    expect(r.components.essential_consistency_points).toBe(25);
    expect(r.reliability_index).toBe(74);
    expect(r.drivers.length).toBeGreaterThan(0);
    expect(r.model_version).toBe(1);
  });

  /**
   * 74, not more: with no money moving into savings the resilience component
   * contributes nothing, so HIGH is unreachable on income and bills alone. That
   * is deliberate — a cushion is the thing the band is meant to certify.
   */
  it('cannot reach HIGH without saving, and does once money is saved', () => {
    const withoutSaving = run(steady(), { acc: '6500.00' });
    expect(withoutSaving.score_band).toBe('MEDIUM');

    // Savings is driven by the transfer classifier, not by the category alone:
    // the model is told which ids moved money INTO a savings account.
    const savingsLegs = WINDOW.months.map((m) => txn(`${m}-20`, '-400.00', '6540'));
    const saving = computeReliabilityIndex({
      window: WINDOW,
      transactions: [...steady(), ...savingsLegs],
      transfers: {
        excludedFromIncome: new Set<string>(),
        excludedFromSpend: new Set(savingsLegs.map((t) => t.id)),
        savingsInIds: new Set(savingsLegs.map((t) => t.id)),
        savingsOutIds: new Set<string>(),
      },
      categories: CATEGORIES,
      closingBalances: { acc: '6500.00' },
    });
    expect(saving.components.resilience_breakdown.savings).toBeGreaterThan(0);
    expect(saving.reliability_index).toBeGreaterThan(withoutSaving.reliability_index);
    expect(saving.score_band).toBe('HIGH');
  });

  /**
   * The balance anchor drives this: the same transactions with a low closing
   * balance reconstruct a window spent overdrawn. Documented as an estimate in
   * docs/scoring-model.md — asserted here so the sensitivity is not a surprise.
   */
  it('penalises a reconstructed overdraft, and the anchor is what decides it', () => {
    const solvent = run(steady(), { acc: '6500.00' });
    const overdrawn = run(steady(), { acc: '500.00' });
    expect(solvent.metrics.negative_balance_days).toBe(0);
    expect(overdrawn.metrics.negative_balance_days).toBeGreaterThan(100);
    expect(overdrawn.components.resilience_breakdown.negative_balance).toBe(-10);
    expect(overdrawn.reliability_index).toBeLessThan(solvent.reliability_index);
  });

  it('is bounded to 0..100 and deterministic for the same input', () => {
    const a = run(steady());
    const b = run(steady());
    expect(a.reliability_index).toBe(b.reliability_index);
    expect(a.metrics).toEqual(b.metrics);
    expect(a.reliability_index).toBeGreaterThanOrEqual(0);
    expect(a.reliability_index).toBeLessThanOrEqual(100);
  });

  it('an empty transaction set scores rather than throwing', () => {
    const r = run([]);
    expect(r.reliability_index).toBeGreaterThanOrEqual(0);
    expect(r.metrics.income_regularity).toBe(0);
    expect(r.metrics.good_months).toBe(0);
  });

  /**
   * A data gap must never read as a perfect score: with no essential spending
   * the coverage ratio is undefined, not infinite.
   */
  it('zero essential expenses scores the 1.0x value, never full marks', () => {
    const r = run([txn('2025-09-01', '5000.00', '9001', { credit: true })]);
    expect(r.components.income_coverage_points).toBeLessThan(MODEL.incomeCoverage.maxPoints);
    expect(r.components.income_coverage_points).toBe(12);
  });

  it('excludes reversed and amended rows from every component', () => {
    const live = run(steady());
    const withDead = run([
      ...steady(),
      txn('2026-01-15', '-9000.00', '7995', { status: 'reversed' }),
      txn('2026-01-16', '-9000.00', '6012', { status: 'amended' }),
    ]);
    expect(withDead.reliability_index).toBe(live.reliability_index);
    expect(withDead.metrics.late_fee_events).toBe(live.metrics.late_fee_events);
  });

  /**
   * A `fees` CREDIT is the bank refunding a charge. Counting it would penalise
   * the applicant a second time for one fee — and penalise them for it being
   * reversed in their favour.
   */
  it('does not count a refunded fee as a fee event', () => {
    const refunded = run([
      ...steady(),
      txn('2026-01-20', '-12.00', '6012'),
      txn('2026-01-25', '12.00', '6012', { credit: true }),
    ]);
    expect(refunded.metrics.late_fee_events).toBe(1);
  });

  it('counts a fee event and penalises it', () => {
    const clean = run(steady());
    const fined = run([...steady(), txn('2026-01-20', '-12.00', '6012')]);
    expect(fined.metrics.late_fee_events).toBe(1);
    expect(fined.components.resilience_breakdown.late_fees).toBeLessThan(0);
    expect(fined.reliability_index).toBeLessThanOrEqual(clean.reliability_index);
  });

  /**
   * A good month needs ALL THREE of income, an essential payment, and no fee.
   * `steady()` satisfies all three in all six months, so each case below breaks
   * exactly one condition in exactly one month and expects five.
   */
  it('a month with no income is not good', () => {
    const noSeptemberIncome = steady().filter((t) => t.bookedAt !== '2025-09-01');
    expect(run(noSeptemberIncome).metrics.good_months).toBe(5);
  });

  it('a month with income but no essential payment is not good', () => {
    const noSeptemberEssentials = steady().filter(
      (t) => t.bookedAt !== '2025-09-05' && t.bookedAt !== '2025-09-09',
    );
    expect(run(noSeptemberEssentials).metrics.good_months).toBe(5);
  });

  it('a month with a fee event is not good even if otherwise complete', () => {
    const fined = [...steady(), txn('2026-01-20', '-12.00', '6012')];
    expect(run(fined).metrics.good_months).toBe(5);
  });

  /**
   * Two fee events either way, so the fee count — and with it every component —
   * is identical; only WHICH months carry them differs. Breaking any condition
   * outright would move a component too, since all three feed A, C or D.
   */
  it('good_months is reported but never scored', () => {
    const oneBadMonth = run([
      ...steady(),
      txn('2026-01-20', '-12.00', '6012'),
      txn('2026-01-21', '-12.00', '6012'),
    ]);
    const twoBadMonths = run([
      ...steady(),
      txn('2026-01-20', '-12.00', '6012'),
      txn('2025-12-21', '-12.00', '6012'),
    ]);

    expect(oneBadMonth.metrics.good_months).toBe(5);
    expect(twoBadMonths.metrics.good_months).toBe(4);
    expect(twoBadMonths.metrics.late_fee_events).toBe(oneBadMonth.metrics.late_fee_events);
    expect(twoBadMonths.components).toEqual(oneBadMonth.components);
    expect(twoBadMonths.reliability_index).toBe(oneBadMonth.reliability_index);
  });

  it('never returns a negative index however bad the inputs', () => {
    const awful = [
      ...WINDOW.months.map((m) => txn(`${m}-10`, '-500.00', '7995')),
      ...WINDOW.months.map((m) => txn(`${m}-11`, '-20.00', '6012')),
    ];
    const r = run(awful, { acc: '-5000.00' });
    expect(r.reliability_index).toBe(0);
    expect(r.score_band).toBe('LOW');
  });
});
