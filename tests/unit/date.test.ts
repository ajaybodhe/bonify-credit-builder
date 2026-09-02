import { describe, expect, it } from 'vitest';
import { scoringWindow, toYearMonth, daysBetween } from '../../src/lib/date.js';

describe('scoringWindow', () => {
  // The published worked example. This is the contract.
  it('from=2026-02-20 spans 2025-09-01..2026-02-20 over six months', () => {
    expect(scoringWindow('2026-02-20')).toEqual({
      start: '2025-09-01',
      end: '2026-02-20',
      months: ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02'],
    });
  });

  it('crosses a year boundary without an off-by-one', () => {
    const w = scoringWindow('2026-01-15');
    expect(w.start).toBe('2025-08-01');
    expect(w.months).toEqual(['2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01']);
  });

  it('handles `from` on the first of a month', () => {
    const w = scoringWindow('2026-03-01');
    expect(w.start).toBe('2025-10-01');
    expect(w.end).toBe('2026-03-01');
    expect(w.months).toHaveLength(6);
  });

  /** Rolling back from a 31st must not land on an invalid date like Feb 31. */
  it('handles a 31st rolling back into a shorter month', () => {
    const w = scoringWindow('2026-03-31');
    expect(w.start).toBe('2025-10-01');
    expect(w.end).toBe('2026-03-31');
    expect(w.months).toHaveLength(6);
  });

  it('always yields exactly six month buckets, in order, ending at from', () => {
    for (const from of ['2026-02-20', '2026-01-01', '2025-12-31', '2026-03-31']) {
      const w = scoringWindow(from);
      expect(w.months).toHaveLength(6);
      expect([...w.months].sort()).toEqual(w.months);
      expect(w.months[5]).toBe(from.slice(0, 7));
      expect(w.end).toBe(from);
    }
  });
});

describe('toYearMonth', () => {
  it('truncates an ISO date to its month bucket', () => {
    expect(toYearMonth('2026-02-20')).toBe('2026-02');
  });
});

describe('daysBetween', () => {
  it('counts whole days between two plain dates', () => {
    expect(daysBetween('2026-01-01', '2026-01-08')).toBe(7);
  });

  it('is negative when the range runs backwards', () => {
    // Coverage shortfall relies on this: a window END before what we covered
    // means no shortfall, and must not read as a large positive one.
    expect(daysBetween('2026-03-10', '2026-03-01')).toBe(-9);
  });

  it('is zero for the same day', () => {
    expect(daysBetween('2026-05-05', '2026-05-05')).toBe(0);
  });

  /**
   * The reason for parsing as UTC rather than local time. Across a DST
   * boundary a local-time subtraction yields 30.958… days, and `Math.floor`
   * would silently lose one — a booking date has no timezone.
   */
  it('is exact across a DST boundary', () => {
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31);
    expect(daysBetween('2026-10-01', '2026-11-01')).toBe(31);
  });

  it('handles a leap day', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });
});
