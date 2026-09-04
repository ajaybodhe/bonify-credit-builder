/**
 * The brief's window is 6 calendar months back from `from`, inclusive:
 * `2026-02-20` → `2025-09-01..2026-02-20`. Plain YYYY-MM-DD in UTC throughout.
 */
import { AppError } from './errors.js';

export const MONTHS_IN_WINDOW = 6;

export type IsoDate = string; // YYYY-MM-DD
export type YearMonth = string; // YYYY-MM

export interface ScoringWindow {
  start: IsoDate;
  end: IsoDate;
  months: YearMonth[];
}

export function scoringWindow(from: IsoDate): ScoringWindow {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from);
  if (!match) {
    throw new AppError('VALIDATION_ERROR', 400, `Not an ISO date: ${from}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  /**
   * Round-tripping catches what the regex cannot: 2026-02-31 and 2026-13-01,
   * and also years below 100, which `Date.UTC` maps into the 1900s.
   *
   * A 400, not a bare Error. This sits behind `isoDateSchema` as
   * defence-in-depth, and a backstop must not report a worse failure than the
   * guard it backs up — a `from` we cannot parse is the caller's mistake
   * wherever it is noticed.
   */
  const end = new Date(Date.UTC(year, month - 1, day));
  if (
    end.getUTCFullYear() !== year ||
    end.getUTCMonth() !== month - 1 ||
    end.getUTCDate() !== day
  ) {
    throw new AppError('VALIDATION_ERROR', 400, `Not a real calendar date: ${from}`);
  }

  const start = new Date(Date.UTC(year, month - MONTHS_IN_WINDOW, 1));

  const months: YearMonth[] = [];
  for (let i = 0; i < MONTHS_IN_WINDOW; i++) {
    const m = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    months.push(m.toISOString().slice(0, 7));
  }

  return { start: start.toISOString().slice(0, 10), end: from, months };
}

export function toYearMonth(date: IsoDate): YearMonth {
  return date.slice(0, 7);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}
