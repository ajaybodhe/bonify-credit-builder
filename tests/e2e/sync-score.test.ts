import { drizzle } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { NotFoundError } from '../../src/lib/errors.js';
import type { BankingApiClient } from '../../src/banking/client.js';
import type { Env } from '../../src/config/env.js';
import type { Database } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import { FakeBankingApi, buildTransactions } from '../helpers/fake-banking-api.js';
import { isolateDictionary, testDatabaseUrl, testPool } from '../helpers/db.js';

/**
 * E2E tier: the whole app via `app.inject()`, real Postgres, and the Banking
 * API replaced by `tests/helpers/fake-banking-api.ts` — never the live upstream.
 *
 * Why this tier exists, given the other three:
 *
 *   unit         the model is right for a given input
 *   integration  each boundary works in isolation
 *   contract     the upstream still behaves as assumed
 *   e2e          the PROMISE — that a score served today can be explained and
 *                reproduced tomorrow
 *
 * That property spans sync, storage, scoring and the audit table, so no
 * narrower tier can reach it.
 */
const pool = testPool();
const db: Database = drizzle(pool, { schema });

const USER = 'user_e2e';
const ACCOUNT = 'acc_e2e_chk';
const FROM = '2026-02-20';
const UNKNOWN = 'user_e2e_missing';

const fake = new FakeBankingApi(buildTransactions(ACCOUNT, 120, '2025-09-01'));

/**
 * Mutable so a test can publish a second dictionary without re-wiring the fake.
 * `buildTransactions` only ever emits 9001 and 5411, so regrouping 5411 is the
 * one edit that reaches every debit the fixture produces.
 */
const BASELINE_CATEGORIES = [
  { code: '9001', name: 'Salary', group: 'income' },
  { code: '5411', name: 'Groceries', group: 'essential' },
  { code: '6513', name: 'Rent', group: 'essential' },
  { code: '6540', name: 'Savings', group: 'savings' },
  { code: '6012', name: 'Fees', group: 'fees' },
  { code: '7995', name: 'Gambling', group: 'high_risk' },
];
let categories: { code: string; name: string; group: string }[] = [...BASELINE_CATEGORIES];

/** Adapts the in-process fake to the client shape the app depends on. */
const banking = {
  getDataRange: () => Promise.resolve({ from: '2025-09-01', to: '2026-06-30' }),
  listAccounts: (userId: string) => {
    // The real client maps a 404 from this endpoint to NotFoundError.
    if (userId === UNKNOWN)
      return Promise.reject(new NotFoundError(`No such user upstream: ${userId}`));
    return Promise.resolve([
      {
        id: ACCOUNT,
        user_id: userId,
        type: 'checking' as const,
        currency: 'EUR',
        balance: 2000,
        name: 'Main',
      },
    ]);
  },
  // eslint-disable-next-line @typescript-eslint/require-await -- generator contract
  async *streamTransactions(accountId: string, range: { from: string; to: string }) {
    let cursor: string | undefined;
    do {
      const page = fake.listTransactions(accountId, range.from, range.to, cursor);
      yield page.transactions;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  },
  listMerchantCategories: () => Promise.resolve(categories),
} as unknown as BankingApiClient;

const env = {
  NODE_ENV: 'test',
  PORT: 0,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  BANKING_API_BASE_URL: 'http://fake.invalid',
  BANKING_API_KEY: 'test',
  BANKING_API_TIMEOUT_MS: 1000,
  BANKING_API_MAX_RETRIES: 0,
  BANKING_API_PAGE_SIZE: 100,
  DATABASE_URL: testDatabaseUrl(),
  DATABASE_POOL_MAX: 4,
} as unknown as Env;

let app: FastifyInstance;
let restoreDictionary: () => Promise<void>;

beforeAll(async () => {
  restoreDictionary = await isolateDictionary(pool);
});

beforeEach(async () => {
  await pool.query('DELETE FROM score_snapshots WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM transactions WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM accounts WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM sync_runs WHERE user_id = $1', [USER]);
  app = await buildApp({ env, db, pool, banking });
});

afterAll(async () => {
  await app.close();
  await restoreDictionary();
  await pool.end();
});

const sync = () => app.inject({ method: 'POST', url: `/api/users/${USER}/sync` });
const score = () =>
  app.inject({ method: 'GET', url: `/api/users/${USER}/reliability?from=${FROM}` });

describe('e2e: sync then score', () => {
  it('syncs a user, then scores them from what was synced', async () => {
    const synced = await sync();
    expect(synced.statusCode).toBe(200);
    expect(synced.json<{ status: string }>().status).toBe('succeeded');
    expect(synced.json<{ new_transactions: number }>().new_transactions).toBeGreaterThan(0);

    const scored = await score();
    expect(scored.statusCode).toBe(200);
    const body = scored.json<{
      reliability_index: number;
      score_band: string;
      drivers: string[];
      model_version: number;
    }>();
    expect(body.reliability_index).toBeGreaterThanOrEqual(0);
    expect(body.reliability_index).toBeLessThanOrEqual(100);
    expect(['LOW', 'MEDIUM', 'HIGH']).toContain(body.score_band);
    // Explainability is the product promise, not a nice-to-have.
    expect(body.drivers.length).toBeGreaterThan(0);
    expect(body.model_version).toBe(1);
  });

  it('re-syncing before scoring does not change the score — dedupe is a no-op', async () => {
    await sync();
    const first = (await score()).json<{ reliability_index: number }>().reliability_index;

    const again = await sync();
    expect(again.json<{ new_transactions: number }>().new_transactions).toBe(0);
    expect(again.json<{ duplicate_transactions: number }>().duplicate_transactions).toBeGreaterThan(
      0,
    );

    expect((await score()).json<{ reliability_index: number }>().reliability_index).toBe(first);
  });

  /**
   * The rule that matters most: absence of data must never read as evidence of
   * unreliability. A user we have never synced is unscoreable, not a zero.
   */
  it('scoring without a prior sync returns 409 SYNC_REQUIRED, never 0/LOW', async () => {
    const res = await score();
    expect(res.statusCode).toBe(409);
    const err = res.json<{ error: { code: string; details: unknown; request_id: string } }>().error;
    expect(err.code).toBe('SYNC_REQUIRED');
    expect(err.request_id).toBeTruthy();
    expect(res.body).not.toContain('reliability_index');
  });
});

describe('e2e: error contract', () => {
  /**
   * A user who does not exist upstream is permanent, not transient. Reported as
   * an upstream failure it is indistinguishable from an outage, so a caller
   * retries a request that can never succeed and burns the rate limit.
   */
  it('an unknown user is 404 USER_NOT_FOUND, not 502', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/users/${UNKNOWN}/sync` });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('USER_NOT_FOUND');
  });

  it('never echoes an upstream response body to the caller', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/users/${UNKNOWN}/sync` });
    const err = res.json<{ error: { details?: unknown } }>().error;
    // Whatever upstream said stays upstream: bodies can carry internal
    // hostnames, identifiers or a stack trace.
    expect(JSON.stringify(err.details ?? {})).not.toMatch(/body/i);
  });

  it('a malformed `from` is 400, and carries a request id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${USER}/reliability?from=2026-13-45`,
    });
    expect(res.statusCode).toBe(400);
    const err = res.json<{ error: { code: string; request_id: string } }>().error;
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.request_id).toBeTruthy();
  });
});

describe('e2e: auditability', () => {
  it('every served score writes exactly one snapshot, naming its versions and inputs', async () => {
    await sync();
    const served = (await score()).json<{ reliability_index: number; model_version: number }>();

    const { rows } = await pool.query<{
      reliability_index: number;
      model_version: number;
      category_version: number;
      input_hash: string;
      closing_balances: Record<string, string> | null;
      sync_run_id: string | null;
    }>(
      `SELECT reliability_index, model_version, category_version, input_hash,
              closing_balances, sync_run_id
         FROM score_snapshots WHERE user_id = $1`,
      [USER],
    );

    expect(rows).toHaveLength(1);
    const snap = rows[0];
    // The stored record must agree with what the caller was told.
    expect(snap?.reliability_index).toBe(served.reliability_index);
    expect(snap?.model_version).toBe(served.model_version);
    // Every input is either recoverable by pointer, or stored because it is not.
    expect(snap?.category_version).toBeGreaterThan(0);
    expect(snap?.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof snap?.closing_balances?.[ACCOUNT]).toBe('string');
    expect(snap?.closing_balances?.[ACCOUNT]).toMatch(/^-?\d+\.\d{2}$/);
    expect(snap?.sync_run_id).toBeTruthy();
  });

  it('scoring twice collapses to one snapshot rather than two identical rows', async () => {
    await sync();
    await score();
    await score();
    const { rows } = await pool.query<{ c: string }>(
      'SELECT count(*)::text AS c FROM score_snapshots WHERE user_id = $1',
      [USER],
    );
    expect(rows[0]?.c).toBe('1');
  });
});

/**
 * A score has two inputs that version independently: the transactions, and the
 * dictionary that says what a merchant category MEANS. These hold the first one
 * still and move the second.
 *
 * The dictionary is not a lookup table applied after the fact — it decides which
 * transactions count as essential spend, savings, fees or high risk, so the same
 * rows under a different dictionary are a different score. That is why a snapshot
 * stores `category_version` beside `model_version`, and why a version is minted
 * rather than overwritten.
 */
describe('e2e: the category dictionary is a scoring input, not a lookup', () => {
  interface Scored {
    reliability_index: number;
    metrics: {
      income_regularity: number;
      income_coverage_ratio: number;
      essential_payments_consistency: number;
    };
  }

  /** The version scoring pins to: whatever the last sync recorded, not the newest. */
  const pinnedVersion = async () =>
    (
      await pool.query<{ v: number }>(
        `SELECT category_version AS v FROM sync_runs
          WHERE user_id = $1 AND category_version IS NOT NULL
          ORDER BY started_at DESC LIMIT 1`,
        [USER],
      )
    ).rows[0]?.v ?? null;

  // Other tests in this file assume the baseline dictionary.
  afterEach(() => {
    categories = [...BASELINE_CATEGORIES];
  });

  it('regrouping a category moves the score, though not one transaction changed', async () => {
    // 1. First sync: stores the transactions, and fetches the dictionary as V1.
    expect((await sync()).json<{ status: string }>().status).toBe('succeeded');
    const v1 = await pinnedVersion();
    expect(v1).not.toBeNull();
    const before = (await score()).json<Scored>();

    // 2. Upstream reclassifies 5411. Every debit the fixture emits carries that
    //    code, and not a single transaction is touched.
    categories = BASELINE_CATEGORIES.map((c) =>
      c.code === '5411' ? { ...c, group: 'high_risk' } : c,
    );

    const resync = (await sync()).json<{
      new_transactions: number;
      duplicate_transactions: number;
      amended_transactions: number;
    }>();
    // The proof that the transaction side stood still: everything was re-read
    // and everything hashed the same.
    expect(resync.new_transactions).toBe(0);
    expect(resync.amended_transactions).toBe(0);
    expect(resync.duplicate_transactions).toBeGreaterThan(0);

    // A differing dictionary mints V2; V1 is kept, so old snapshots stay readable.
    expect(await pinnedVersion()).toBe((v1 ?? 0) + 1);

    // 3. Same rows, different meaning — so a different score.
    const after = (await score()).json<Scored>();
    expect(after.reliability_index).not.toBe(before.reliability_index);
    expect(after.reliability_index).toBeLessThan(before.reliability_index);

    // WHY, component by component — the score moves for reasons, not by luck:
    // C) essential category-months: 5411 is no longer essential, so there are none.
    expect(before.metrics.essential_payments_consistency).toBeGreaterThan(0);
    expect(after.metrics.essential_payments_consistency).toBe(0);
    // B) income coverage: with no essential spend the ratio is undefined, and the
    //    model pins that to break-even rather than letting a data gap read as
    //    perfect coverage.
    expect(after.metrics.income_coverage_ratio).toBeLessThan(before.metrics.income_coverage_ratio);
    // A) income regularity is unmoved: income is decided by `is_credit`, which no
    //    dictionary edit can reach. A control on the other two.
    expect(after.metrics.income_regularity).toBe(before.metrics.income_regularity);
  });

  /**
   * The other half of the question: a new version does NOT imply a new score.
   * Versions are minted on the content hash, which covers the display name;
   * scoring reads only code and group.
   */
  it('a relabelled dictionary mints a version but cannot move the score', async () => {
    await sync();
    const v1 = await pinnedVersion();
    const before = (await score()).json<Scored>();

    // Same codes, same groups. Only the human-readable label differs.
    categories = BASELINE_CATEGORIES.map((c) =>
      c.code === '5411' ? { ...c, name: 'Supermarkets & Grocery' } : c,
    );
    await sync();

    expect(await pinnedVersion()).toBe((v1 ?? 0) + 1);
    expect((await score()).json<Scored>().reliability_index).toBe(before.reliability_index);
  });

  /**
   * A GAP, pinned here rather than asserted as correct.
   *
   * `score_snapshots_reproducibility_idx` is on
   * `(user_id, window_end, model_version, input_hash)`, and `input_hash` covers
   * the transactions and closing balances — not `category_version`. So when the
   * dictionary alone moves the score, the second snapshot collides with the
   * first and `onConflictDoNothing` discards it: a score was served that the
   * audit table has no record of, and the row it does hold reports the older
   * number.
   *
   * This asserts what the code does today so the behaviour cannot change
   * unnoticed. Adding `category_version` to that index would make both scores
   * storable — a schema change, so it is deliberately not made here.
   */
  it('DOCUMENTS A GAP: the dictionary-driven score is served but never recorded', async () => {
    await sync();
    const before = (await score()).json<Scored>();

    categories = BASELINE_CATEGORIES.map((c) =>
      c.code === '5411' ? { ...c, group: 'high_risk' } : c,
    );
    await sync();
    const after = (await score()).json<Scored>();
    expect(after.reliability_index).not.toBe(before.reliability_index);

    const { rows } = await pool.query<{ reliability_index: number; category_version: number }>(
      `SELECT reliability_index, category_version FROM score_snapshots
        WHERE user_id = $1 ORDER BY computed_at`,
      [USER],
    );
    // Two distinct scores were served; one snapshot exists.
    expect(rows).toHaveLength(1);
    // And it is the FIRST one — the served score is not the recorded score.
    expect(rows[0]?.reliability_index).toBe(before.reliability_index);
    expect(rows[0]?.reliability_index).not.toBe(after.reliability_index);
  });

  /** And an unchanged dictionary mints nothing, so versions track meaning, not syncs. */
  it('an identical dictionary does not mint a version at all', async () => {
    await sync();
    const v1 = await pinnedVersion();
    await sync();
    expect(await pinnedVersion()).toBe(v1);
  });
});
