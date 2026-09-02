import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Local mirror of the Banking API, plus an audit trail of what we computed.
 *
 * Money is `numeric(14, 2)`, never a float: a reliability score that depends on
 * summed amounts must not drift with binary rounding. Drizzle returns numeric
 * as a string; conversion to minor units happens at the edge of the scoring
 * module, not in SQL.
 */

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(), // upstream account id
    userId: text('user_id').notNull(),
    name: text('name'),
    type: text('type'),
    currency: text('currency').notNull().default('EUR'),
    // Latest balance reported upstream. Used to anchor the running-balance
    // reconstruction behind `negative_balance_days`.
    currentBalance: numeric('current_balance', { precision: 14, scale: 2 }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('accounts_user_id_idx').on(t.userId)],
);

export const transactions = pgTable(
  'transactions',
  {
    // Primary key is the UPSTREAM id, so dedupe is a primary-key conflict
    // rather than a read-then-write race.
    //
    // We do NOT assume upstream transactions are immutable. `contentHash` is a
    // digest of the scoring-relevant fields; on conflict the sync compares it
    // and, when it differs, writes a new revision instead of silently ignoring
    // the row. A bank that reverses or re-books a transaction is normal, and a
    // dedupe that cannot see it would leave the local mirror permanently and
    // invisibly wrong.
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    bookedAt: date('booked_at').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('EUR'),
    description: text('description'),
    merchant: text('merchant'),
    // Upstream category verbatim. Any mapping to essential/high_risk/savings
    // lives in the scoring module so the raw value stays re-interpretable when
    // the model changes.
    category: text('category'),
    isCredit: boolean('is_credit').notNull(),

    /**
     * Lifecycle of the row as understood locally.
     * - `active`   — current, counts toward scoring
     * - `amended`  — upstream changed the content; superseded by a newer revision
     * - `reversed` — upstream reversed it; excluded from scoring
     * Scoring queries MUST filter on `status = 'active'`.
     */
    status: text('status', { enum: ['active', 'amended', 'reversed'] })
      .notNull()
      .default('active'),
    /** Digest of the scoring-relevant fields. Changes ⇒ upstream amended the row. */
    contentHash: text('content_hash').notNull(),
    /** Incremented every time contentHash changes for this id. */
    revision: integer('revision').notNull().default(1),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The scoring query's access path: one user, one date range, ordered.
    index('transactions_user_booked_idx').on(t.userId, t.bookedAt),
    index('transactions_account_booked_idx').on(t.accountId, t.bookedAt),
    index('transactions_category_idx').on(t.category),
    index('transactions_status_idx').on(t.status),
  ],
);

/**
 * Append-only history of amendments. When upstream changes a transaction we
 * keep what we previously believed, so a score computed last month can still be
 * reproduced from the data as it stood at the time.
 *
 * Without this table an amendment is indistinguishable from a bug: the score
 * moves, the transaction set looks "correct", and nothing records that the
 * ground truth shifted underneath us.
 */
export const transactionRevisions = pgTable(
  'transaction_revisions',
  {
    id: text('id').primaryKey(),
    transactionId: text('transaction_id').notNull(),
    revision: integer('revision').notNull(),
    contentHash: text('content_hash').notNull(),
    /** Full previous row as JSON — cheap, and the only way to diff after the fact. */
    previous: jsonb('previous').notNull(),
    detectedBySyncId: text('detected_by_sync_id'),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('transaction_revisions_txn_idx').on(t.transactionId, t.revision),
    uniqueIndex('transaction_revisions_unique_idx').on(t.transactionId, t.revision),
  ],
);

/**
 * Versioned snapshots of the Banking API's merchant category dictionary.
 *
 * The dictionary decides which codes are essential, high-risk, savings, income
 * and fees, so it is an input to components B, C and D — and it is external
 * data upstream can change at any time. If a code moves between groups, every
 * score computed under the old grouping becomes unexplainable unless the old
 * grouping survives.
 *
 * So the dictionary is versioned rather than overwritten. A refresh hashes what
 * upstream returned: identical to the current version, nothing happens;
 * different, a new version is created and the old one is kept. A score records
 * only `category_version`, exactly as it records `model_version` — the mapping
 * itself is never copied into the snapshot.
 *
 * This mirrors how model versions work, with one difference worth naming: a
 * model version is frozen because we control the code, while a dictionary
 * version is immutable because it is a record of what upstream said at a point
 * in time. Neither may ever be deleted, or the scores referencing them lose
 * their meaning.
 */
export const merchantCategoryVersions = pgTable('merchant_category_versions', {
  version: integer('version').primaryKey(),
  /**
   * Digest of the dictionary content. A refresh compares against this to decide
   * whether anything actually changed — upstream returning the same data must
   * not mint a new version.
   */
  contentHash: text('content_hash').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});

export const merchantCategories = pgTable(
  'merchant_categories',
  {
    version: integer('version')
      .notNull()
      .references(() => merchantCategoryVersions.version),
    /** Merchant category code, e.g. '6513'. Matches transactions.category. */
    code: text('code').notNull(),
    name: text('name').notNull(),
    /**
     * The upstream grouping, and the single source of truth for scoring
     * semantics: essential | discretionary | high_risk | savings | cash |
     * income | fees. Nothing in this service hardcodes category membership.
     */
    group: text('group', {
      enum: ['essential', 'discretionary', 'high_risk', 'savings', 'cash', 'income', 'fees'],
    }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.version, t.code] })],
);

/**
 * One row per sync attempt. This is what makes "the score changed overnight"
 * debuggable: it says what was pulled, when, and whether it completed.
 */
export const syncRuns = pgTable(
  'sync_runs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    status: text('status', {
      enum: ['running', 'succeeded', 'partial', 'failed', 'abandoned'],
    }).notNull(),
    /**
     * The category dictionary version in force when this run finished. Scoring
     * pins to it, so a score is interpreted with the same mapping the data was
     * synced under — and so the scoring path never has to ask upstream.
     *
     * Null only when no dictionary has ever been fetched, which scoring reports
     * as `CATEGORIES_UNAVAILABLE` from local state alone.
     */
    categoryVersion: integer('category_version'),
    syncedFrom: date('synced_from'),
    syncedAccounts: integer('synced_accounts').notNull().default(0),
    newTransactions: integer('new_transactions').notNull().default(0),
    duplicateTransactions: integer('duplicate_transactions').notNull().default(0),
    amendedTransactions: integer('amended_transactions').notNull().default(0),
    pagesFetched: integer('pages_fetched').notNull().default(0),
    /** Accounts that completed vs. were attempted — the basis of `partial`. */
    accountsCompleted: integer('accounts_completed').notNull().default(0),
    accountsFailed: integer('accounts_failed').notNull().default(0),
    /** Newest booking date confirmed present after this run, across all accounts. */
    coversThrough: date('covers_through'),
    /**
     * Account ids this run walked to completion, as a JSON array.
     *
     * This is the whole of the service's coverage bookkeeping. Because every run
     * re-walks the same range for every account, per-account checkpoints would
     * hold identical values and serve no resume purpose — so coverage is
     * answered by asking which runs covered which accounts, not by a mutable
     * per-account table. A count would not do: closing one account and opening
     * another leaves the count equal while the SET differs.
     */
    coveredAccountIds: jsonb('covered_account_ids').notNull().default([]),
    /** Set when a sync was triggered by a scoring request rather than a caller. */
    trigger: text('trigger', { enum: ['api', 'scoring', 'scheduled', 'webhook'] })
      .notNull()
      .default('api'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('sync_runs_user_started_idx').on(t.userId, t.startedAt),
    /**
     * This index IS the mutual exclusion for sync
     * (docs/architecture-design.md §4.5), not a backstop
     * for one: `INSERT` under it is atomic, so there is no check-then-act
     * window for two claimants to slip through. Measured, 20 simultaneous
     * claims yield 1 winner and 19 `23505`s.
     *
     * It is only safe because stale `running` rows are reclaimed as
     * `abandoned` in the same transaction that inserts — see
     * `modules/sync/claim.ts`. Without that, one crashed process would refuse
     * that user's syncs forever, which is worse than the race it prevents.
     */
    uniqueIndex('sync_runs_one_running_per_user_idx')
      .on(t.userId)
      .where(sql`status = 'running'`),
  ],
);

/**
 * Immutable record of every score served. Required for the auditability story:
 * reproducing a past decision needs the inputs, the model version, and the
 * component breakdown — not just the final integer.
 */
export const scoreSnapshots = pgTable(
  'score_snapshots',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    windowStart: date('window_start').notNull(),
    windowEnd: date('window_end').notNull(),
    /**
     * Points at an implementation in `src/modules/reliability/models/`, which
     * keeps every released version forever and never edits one. So this number
     * alone identifies both the constants and the logic that produced the
     * score, and none of the model needs copying into the row.
     */
    modelVersion: integer('model_version').notNull(),
    reliabilityIndex: integer('reliability_index').notNull(),
    scoreBand: text('score_band', { enum: ['LOW', 'MEDIUM', 'HIGH'] }).notNull(),
    metrics: jsonb('metrics').notNull(),
    components: jsonb('components').notNull(),
    drivers: jsonb('drivers').notNull(),
    /**
     * Digest of the exact transaction set that produced this score.
     *
     * Its purpose is VERIFICATION, not just change-detection. The scored set is
     * rebuildable at any later date — `transactions.ingested_at` excludes rows
     * that arrived afterwards, `transaction_revisions` rolls back amendments,
     * and nothing is deleted — so an auditor reconstructs the set, hashes it,
     * and compares. A match proves they are holding the same inputs the score
     * was computed from.
     */
    inputHash: text('input_hash').notNull(),
    /**
     * The per-account balance each account closed the window on — the anchor
     * the resilience component walks back from. Stored because it cannot be
     * recovered later: `accounts.current_balance` is overwritten by every sync.
     *
     * Nullable only for snapshots written before this column existed. A rebuild
     * must refuse those rather than assume a balance, the same way a missing
     * model version throws instead of falling back to the current one.
     */
    closingBalances: jsonb('closing_balances').$type<Record<string, string>>(),
    /**
     * Points at a row in `merchant_category_versions`, which keeps every
     * dictionary the service has ever seen. As with `modelVersion`, the number
     * alone is enough: the mapping is never copied into the snapshot, and
     * regrouping a code upstream mints a new version rather than rewriting the
     * old one.
     */
    categoryVersion: integer('category_version').notNull(),
    /**
     * The data conditions this score was computed under. A credit decision made
     * on an incomplete history is the worst failure this service can have, so
     * the conditions are recorded with the decision rather than inferred later.
     */
    dataQuality: jsonb('data_quality').notNull(),
    /**
     * The sync run whose data this score used — what makes "was Tuesday's score
     * computed on good data?" answerable three weeks later.
     */
    syncRunId: text('sync_run_id'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('score_snapshots_user_computed_idx').on(t.userId, t.computedAt),
    uniqueIndex('score_snapshots_reproducibility_idx').on(
      t.userId,
      t.windowEnd,
      t.modelVersion,
      t.inputHash,
    ),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type SyncRun = typeof syncRuns.$inferSelect;
export type TransactionRevision = typeof transactionRevisions.$inferSelect;
export type MerchantCategoryRow = typeof merchantCategories.$inferSelect;
export type MerchantCategoryVersion = typeof merchantCategoryVersions.$inferSelect;
export type ScoreSnapshot = typeof scoreSnapshots.$inferSelect;
