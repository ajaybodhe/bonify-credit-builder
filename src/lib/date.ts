/**
 * Scoring-window arithmetic.
 *
 * The brief defines the window as "6 calendar months back from `from`
 * (inclusive)", with the worked example `from=2026-02-20` -> `2025-09-01` to
 * `2026-02-20`. So the window starts on the FIRST DAY of the month five months
 * before `from`'s month, giving six calendar months of coverage
 * (Sep, Oct, Nov, Dec, Jan, Feb) with the final month truncated at `from`.
 *
 * All dates are handled as plain YYYY-MM-DD strings in UTC. There is no
 * timezone in a bank statement date, and introducing one only creates
 * off-by-one bugs at month boundaries.
 */
export const MONTHS_IN_WINDOW = 6;

export type IsoDate = string; // YYYY-MM-DD
export type YearMonth = string; // YYYY-MM

export interface ScoringWindow {
  /** Inclusive first day of the window, e.g. 2025-09-01. */
  start: IsoDate;
  /** Inclusive last day of the window — the caller's `from`. */
  end: IsoDate;
  /** The MONTHS_IN_WINDOW year-month buckets the window spans, oldest first. */
  months: YearMonth[];
}

/**
 * No `months` parameter: the brief fixes the window at six, `MONTHS_IN_WINDOW`
 * is the single definition, and a configurable width would imply a flexibility
 * the scoring model does not have (every component divides by six).
 */
export function scoringWindow(from: IsoDate): ScoringWindow {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from);
  if (!match) throw new Error(`Not an ISO date: ${from}`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Round-tripping through Date.UTC catches 2026-02-31 and 2026-13-01, which
  // the regex alone accepts.
  const end = new Date(Date.UTC(year, month - 1, day));
  if (
    end.getUTCFullYear() !== year ||
    end.getUTCMonth() !== month - 1 ||
    end.getUTCDate() !== day
  ) {
    throw new Error(`Not a real calendar date: ${from}`);
  }

  // The window opens on the first day of the month MONTHS_IN_WINDOW-1 back, so
  // `from`'s own month is the sixth and last. Date.UTC normalises a negative
  // month index across the year boundary, which is why this needs no branch.
  const start = new Date(Date.UTC(year, month - MONTHS_IN_WINDOW, 1));

  const months: YearMonth[] = [];
  for (let i = 0; i < MONTHS_IN_WINDOW; i++) {
    const m = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    months.push(m.toISOString().slice(0, 7));
  }

  return { start: start.toISOString().slice(0, 10), end: from, months };
}

/** Truncates an ISO date to the month bucket the scoring window groups by. */
export function toYearMonth(date: IsoDate): YearMonth {
  return date.slice(0, 7);
}

/**
 * Whole days from `from` to `to`, negative if `to` precedes it. Both are plain
 * `YYYY-MM-DD` in UTC, so this is exact — no DST hour to lose.
 */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}
