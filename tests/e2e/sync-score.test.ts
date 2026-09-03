import { drizzle } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { NotFoundError } from '../../src/lib/errors.js';
import type { BankingApiClient } from '../../src/banking/client.js';
import type { Env } from '../../src/config/env.js';
import type { Database } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import { FakeBankingApi, buildTransactions } from '../helpers/fake-banking-api.js';
import { isolateDictionary, testPool } from '../helpers/db.js';

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
  listMerchantCategories: () =>
    Promise.resolve([
      { code: '9001', name: 'Salary', group: 'income' },
      { code: '5411', name: 'Groceries', group: 'essential' },
      { code: '6513', name: 'Rent', group: 'essential' },
      { code: '6540', name: 'Savings', group: 'savings' },
      { code: '6012', name: 'Fees', group: 'fees' },
      { code: '7995', name: 'Gambling', group: 'high_risk' },
    ]),
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
  DATABASE_URL: process.env['DATABASE_URL'] ?? '',
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
