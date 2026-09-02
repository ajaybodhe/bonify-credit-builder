import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { ScoringWindow } from '../../lib/date.js';
import type { ScoredTransaction } from './scoring.js';

/**
 * Rebuilding the inputs a past score was computed from.
 *
 * A snapshot stores `model_version`, `category_version` and `input_hash` — three
 * pointers, no copies. Re-deriving the score means turning those back into
 * inputs:
 *
 *   model            → look up the frozen implementation in `models/`
 *   category mapping → read the rows for that `category_version`
 *   transactions     → rebuild the set as it stood when the score was computed
 *
 * Only the third is non-trivial, and it is possible because the transaction
 * store is append-mostly: rows carry `ingested_at`, amendments archive the
 * prior state in `transaction_revisions`, and nothing is ever deleted.
 *
 * `input_hash` then verifies the result. If the rebuilt set hashes to the value
 * on the snapshot, the reconstruction is provably the same set the score was
 * computed from — which is what makes this an audit rather than a re-run.
 */

/** A transaction as it stood at a point in time. Shape matches the live row. */
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
 * The active transaction set for `window`, as it stood at `asOf`.
 *
 * Three corrections are applied to the current table:
 *
 * 1. **Rows that did not exist yet** are dropped (`ingested_at > asOf`).
 * 2. **Rows amended since** are rolled back. `transaction_revisions` stores the
 *    state *before* each change, so the state at `asOf` is the `previous` of
 *    the EARLIEST revision detected after `asOf`.
 * 3. **Status is taken from the rolled-back row**, so a transaction reversed
 *    after the score still counts as `active` for that score.
 *
 * The candidate set is widened to include rows whose *previous* `booked_at` fell
 * in the window, because an amendment can move a transaction across a month
 * boundary — it would otherwise vanish from a window it was scored in.
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
                   -- Archived rows may be keyed either way depending on whether
                   -- they were captured through the ORM or with to_jsonb().
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

  // Filtering in JS, not SQL: a rolled-back row is jsonb whose keys follow the
  // ORM's camelCase naming, so the two branches of the COALESCE do not share a
  // column shape. Normalising here keeps the query readable.
  return rows
    .map((r) => normalise(r.row as unknown as Record<string, unknown>))
    .filter(
      (t) => t.status === 'active' && t.booked_at >= window.start && t.booked_at <= window.end,
    );
}

/** Accepts either a live row (snake_case) or an archived one (camelCase). */
/**
 * Money, back to the canonical `numeric(14,2)` string form.
 *
 * A typed column arrives as `"-42.50"`; the SAME value read out of a `jsonb`
 * archive arrives as the JS number `-42.5`, because `to_jsonb` writes a JSON
 * number and node-postgres parses it. `String()` on that gives `"-42.5"`.
 *
 * That one trailing zero is the difference between a snapshot being verifiable
 * and not: `input_hash` is computed over the live string at scoring time, so a
 * rebuild that produced `"-42.5"` could never reproduce it, and every audit
 * would report a mismatch that was really a formatting artefact.
 */
function money(value: unknown): string {
  if (typeof value === 'number') return value.toFixed(2);
  const asString = String(value);
  // Already canonical (from a typed column) — leave it exactly as it is.
  return /^-?\d+\.\d{2}$/.test(asString) ? asString : Number(asString).toFixed(2);
}

function normalise(row: Record<string, unknown>): HistoricalTransaction {
  /**
   * Only the fields whose casing actually differs need a fallback: a row comes
   * back either as typed columns (snake_case) or as an archived `jsonb`
   * snapshot written through the ORM (camelCase). Fields spelled the same in
   * both are read directly — `pick('id', 'id')` said nothing.
   */
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

/** The category code → group mapping recorded under one dictionary version. */
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

/**
 * Adapts a rebuilt row to the shape the scoring model consumes.
 *
 * The rebuild speaks the database's snake_case, because half its rows come back
 * as archived `jsonb` rather than as typed columns. The model speaks the ORM's
 * camelCase. Replaying a snapshot means crossing that boundary, and doing it
 * here — once — keeps the seam out of every caller that wants to re-derive a
 * score.
 */
const TRANSACTION_STATUSES = ['active', 'amended', 'reversed'] as const;
type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/**
 * A rebuilt row's `status` is a bare string — half of them come back out of a
 * `jsonb` snapshot. The model treats it as a closed set and filters on
 * `'active'`, so an unrecognised value would silently drop the row from every
 * component rather than being noticed. Validate at the boundary.
 */
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
 * Fingerprint of everything the model consumed — the scored transactions AND
 * the balance each account closed the window on.
 *
 * Balances belong here for two reasons. They are a model input: the resilience
 * component walks back from them, so a score cannot be recomputed without them.
 * And they move independently of transactions — `accounts.current_balance` is
 * overwritten by every sync and the provider does not reconcile it against the
 * rows it publishes. Hashing transactions alone would let a restated balance
 * produce a different score under an unchanged fingerprint, and since this hash
 * is also the snapshot dedupe key, the second score would be served while the
 * stored snapshot silently kept the first.
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

/** Fingerprint of the transaction set alone — the half a rebuild reconstructs. */
export function hashTransactionSet(transactions: readonly HistoricalTransaction[]): string {
  const canonical = [...transactions]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) =>
      // `account_id` belongs here: it decides transfer classification and which
      // balance series a row belongs to, so an amendment moving a transaction
      // between the user's own accounts changes the score. Without it the
      // fingerprint would be unchanged, and because it is also the snapshot
      // dedupe key, the new score would be served while the stored snapshot
      // silently kept the old one.
      [t.id, t.account_id, t.booked_at, t.amount, t.category ?? '', t.is_credit ? 'C' : 'D'].join(
        '|',
      ),
    )
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}
