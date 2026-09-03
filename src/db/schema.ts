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

/** Local mirror plus an audit trail. Money is `numeric(14,2)`, never a float. */

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(), // upstream account id
    userId: text('user_id').notNull(),
    name: text('name'),
    type: text('type'),
    currency: text('currency').notNull().default('EUR'),
    /**
     * `dormant` = still here, no longer published by the Banking API. Upstream
     * exposes no deletion signal, so absence from a successful account listing
     * is the only evidence there is. Coverage requires only `active` accounts:
     * a closed account can never be re-fetched, so demanding it would refuse
     * the user forever.
     */
    status: text('status', { enum: ['active', 'dormant'] })
      .notNull()
      .default('active'),
    currentBalance: numeric('current_balance', { precision: 14, scale: 2 }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('accounts_user_id_idx').on(t.userId)],
);

export const transactions = pgTable(
  'transactions',
  {
    // Rows are NOT assumed immutable: a differing `contentHash` writes a new revision.
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
    category: text('category'),
    isCredit: boolean('is_credit').notNull(),

    /** Scoring queries MUST filter on `status = 'active'`. */
    status: text('status', { enum: ['active', 'amended', 'reversed'] })
      .notNull()
      .default('active'),
    contentHash: text('content_hash').notNull(),
    revision: integer('revision').notNull().default(1),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('transactions_user_booked_idx').on(t.userId, t.bookedAt),
    index('transactions_account_booked_idx').on(t.accountId, t.bookedAt),
    index('transactions_category_idx').on(t.category),
    index('transactions_status_idx').on(t.status),
  ],
);

export const transactionRevisions = pgTable(
  'transaction_revisions',
  {
    id: text('id').primaryKey(),
    transactionId: text('transaction_id').notNull(),
    revision: integer('revision').notNull(),
    contentHash: text('content_hash').notNull(),
    previous: jsonb('previous').notNull(),
    detectedBySyncId: text('detected_by_sync_id'),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('transaction_revisions_txn_idx').on(t.transactionId, t.revision),
    uniqueIndex('transaction_revisions_unique_idx').on(t.transactionId, t.revision),
  ],
);

/** Versioned, never overwritten — which is what lets a score store the number. */
export const merchantCategoryVersions = pgTable('merchant_category_versions', {
  version: integer('version').primaryKey(),
  contentHash: text('content_hash').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});

export const merchantCategories = pgTable(
  'merchant_categories',
  {
    version: integer('version')
      .notNull()
      .references(() => merchantCategoryVersions.version),
    code: text('code').notNull(),
    name: text('name').notNull(),
    group: text('group', {
      enum: ['essential', 'discretionary', 'high_risk', 'savings', 'cash', 'income', 'fees'],
    }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.version, t.code] })],
);

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    status: text('status', {
      enum: ['running', 'succeeded', 'partial', 'failed', 'abandoned'],
    }).notNull(),
    categoryVersion: integer('category_version'),
    syncedFrom: date('synced_from'),
    syncedAccounts: integer('synced_accounts').notNull().default(0),
    newTransactions: integer('new_transactions').notNull().default(0),
    duplicateTransactions: integer('duplicate_transactions').notNull().default(0),
    amendedTransactions: integer('amended_transactions').notNull().default(0),
    pagesFetched: integer('pages_fetched').notNull().default(0),
    accountsCompleted: integer('accounts_completed').notNull().default(0),
    accountsFailed: integer('accounts_failed').notNull().default(0),
    coversThrough: date('covers_through'),
    /** Coverage bookkeeping. A count would not do: the SET is what matters. */
    coveredAccountIds: jsonb('covered_account_ids').notNull().default([]),
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
     * This index IS the mutual exclusion for sync, not a backstop for one. Safe only
     * because `sync/claim.ts` reclaims stale rows in the same transaction.
     */
    uniqueIndex('sync_runs_one_running_per_user_idx')
      .on(t.userId)
      .where(sql`status = 'running'`),
  ],
);

export const scoreSnapshots = pgTable(
  'score_snapshots',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    windowStart: date('window_start').notNull(),
    windowEnd: date('window_end').notNull(),
    modelVersion: integer('model_version').notNull(),
    reliabilityIndex: integer('reliability_index').notNull(),
    scoreBand: text('score_band', { enum: ['LOW', 'MEDIUM', 'HIGH'] }).notNull(),
    metrics: jsonb('metrics').notNull(),
    components: jsonb('components').notNull(),
    drivers: jsonb('drivers').notNull(),
    inputHash: text('input_hash').notNull(),
    /** Unrecoverable later: every sync overwrites `accounts.current_balance`. */
    closingBalances: jsonb('closing_balances').$type<Record<string, string>>(),
    categoryVersion: integer('category_version').notNull(),
    dataQuality: jsonb('data_quality').notNull(),
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
