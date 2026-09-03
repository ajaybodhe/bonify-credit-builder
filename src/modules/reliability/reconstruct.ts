import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { ScoringWindow } from '../../lib/date.js';
import type { ScoredTransaction } from './scoring.js';

/**
 * Rebuilding the inputs a past score was computed from: `ingested_at` dates every
 * row, amendments archive the prior state, nothing is deleted. Matching
 * `input_hash` is what makes it an audit rather than a re-run.
 */

export interface HistoricalTransaction {
  id: string;
  account_id: string;
  user_id: string;
  booked_at: string;
  amount: string;
  currency: string;
  description: string | null;
  merchant: string | null;
  category: string | null;
  is_credit: boolean;
  status: string;
  content_hash: string;
  revision: number;
}

/**
 * The set as it stood at `asOf`: rows that did not exist yet are dropped, rows
 * amended since are rolled back, status included. Candidates include rows whose
 * *previous* `booked_at` fell in the window — an amendment can move one out.
 */
export async function transactionsAsOf(
  client: pg.PoolClient,
  userId: string,
  window: ScoringWindow,
  asOf: Date,
): Promise<HistoricalTransaction[]> {
  const { rows } = await client.query<{ row: HistoricalTransaction }>(
    `WITH candidate AS (
         SELECT t.*
           FROM transactions t
          WHERE t.user_id = $1
            AND t.ingested_at <= $4
            AND (
              (t.booked_at BETWEEN $2::date AND $3::date)
              OR EXISTS (
                SELECT 1 FROM transaction_revisions r
                 WHERE r.transaction_id = t.id
                   -- Archived rows may be keyed either way, depending on capture.
                   AND COALESCE(r.previous ->> 'booked_at', r.previous ->> 'bookedAt')::date
                         BETWEEN $2::date AND $3::date
              )
            )
     ),
     rolled_back AS (
         SELECT DISTINCT ON (r.transaction_id) r.transaction_id, r.previous
           FROM transaction_revisions r
           JOIN candidate c ON c.id = r.transaction_id
          WHERE r.detected_at > $4
          ORDER BY r.transaction_id, r.detected_at ASC
     )
     SELECT COALESCE(rb.previous, to_jsonb(c)) AS row
       FROM candidate c
       LEFT JOIN rolled_back rb ON rb.transaction_id = c.id`,
    [userId, window.start, window.end, asOf],
  );

  return rows
    .map((r) => normalise(r.row as unknown as Record<string, unknown>))
    .filter(
      (t) => t.status === 'active' && t.booked_at >= window.start && t.booked_at <= window.end,
    );
}

/**
 * A typed column gives `"-42.50"`; the same value out of a `jsonb` archive gives
 * the number -42.5. `input_hash` is computed over the live string, so without
 * this every audit would report a false mismatch.
 */
function money(value: unknown): string {
  if (typeof value === 'number') return value.toFixed(2);
  const asString = String(value);
  return /^-?\d+\.\d{2}$/.test(asString) ? asString : Number(asString).toFixed(2);
}

function normalise(row: Record<string, unknown>): HistoricalTransaction {
  const either = (snake: string, camel: string): unknown => row[snake] ?? row[camel];
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    id: String(row['id']),
    account_id: String(either('account_id', 'accountId')),
    user_id: String(either('user_id', 'userId')),
    booked_at: String(either('booked_at', 'bookedAt')).slice(0, 10),
    amount: money(row['amount']),
    currency: String(row['currency']),
    description: str(row['description']),
    merchant: str(row['merchant']),
    category: str(row['category']),
    is_credit: Boolean(either('is_credit', 'isCredit')),
    status: String(row['status']),
    content_hash: String(either('content_hash', 'contentHash')),
    revision: Number(row['revision']),
  };
}

export async function categoryMappingForVersion(
  client: pg.PoolClient,
  version: number,
): Promise<Record<string, string>> {
  const { rows } = await client.query<{ code: string; group: string }>(
    'SELECT code, "group" FROM merchant_categories WHERE version = $1 ORDER BY code',
    [version],
  );
  if (rows.length === 0) {
    throw new Error(
      `No merchant category dictionary for version ${String(version)}. Dictionary ` +
        'versions are never deleted; a snapshot referencing a missing one cannot be explained.',
    );
  }
  return Object.fromEntries(rows.map((r) => [r.code, r.group]));
}

const TRANSACTION_STATUSES = ['active', 'amended', 'reversed'] as const;
type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

function asStatus(value: string): TransactionStatus {
  if ((TRANSACTION_STATUSES as readonly string[]).includes(value)) {
    return value as TransactionStatus;
  }
  throw new Error(
    `Rebuilt transaction has unknown status "${value}"; expected one of ` +
      TRANSACTION_STATUSES.join(', '),
  );
}

export function toScoringTransactions(rows: readonly HistoricalTransaction[]): ScoredTransaction[] {
  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    userId: r.user_id,
    bookedAt: r.booked_at,
    amount: r.amount,
    currency: r.currency,
    description: r.description,
    merchant: r.merchant,
    category: r.category,
    isCredit: r.is_credit,
    status: asStatus(r.status),
    contentHash: r.content_hash,
    revision: r.revision,
  }));
}

/**
 * Also the snapshot dedupe key, so anything that can change the score must be in
 * it — balances included, since every sync overwrites `current_balance`.
 */
export function hashScoringInputs(
  transactions: readonly HistoricalTransaction[],
  closingBalances: Readonly<Record<string, string>>,
): string {
  const balances = Object.keys(closingBalances)
    .sort()
    .map((id) => `${id}=${closingBalances[id] ?? ''}`)
    .join(',');
  return createHash('sha256')
    .update(`${hashTransactionSet(transactions)}\n${balances}`)
    .digest('hex');
}

export function hashTransactionSet(transactions: readonly HistoricalTransaction[]): string {
  const canonical = [...transactions]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) =>
      // `account_id`: an amendment moving a row between own accounts changes the score.
      [t.id, t.account_id, t.booked_at, t.amount, t.category ?? '', t.is_credit ? 'C' : 'D'].join(
        '|',
      ),
    )
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}
