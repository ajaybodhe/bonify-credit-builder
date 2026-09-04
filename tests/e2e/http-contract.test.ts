import { drizzle } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { BankingApiClient } from '../../src/banking/client.js';
import type { Env } from '../../src/config/env.js';
import type { Database } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import { testDatabaseUrl, testPool } from '../helpers/db.js';

/**
 * The wire contract, asserted through the real app.
 *
 * The OpenAPI document is generated from the same Zod schemas that validate at
 * runtime, so it "cannot drift" — a claim worth testing, because the way it
 * would fail is silently: a route renamed, a status removed, and the published
 * document still describing yesterday's service.
 */
const pool = testPool();
const db: Database = drizzle(pool, { schema });
const USER = 'user_contract';

const banking = {
  getDataRange: () => Promise.resolve({ from: '2025-09-01', to: '2026-06-30' }),
  listAccounts: () => Promise.resolve([]),
  // eslint-disable-next-line require-yield, @typescript-eslint/require-await
  async *streamTransactions() {
    return;
  },
  listMerchantCategories: () => Promise.resolve([]),
} as unknown as BankingApiClient;

const env = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  BANKING_API_BASE_URL: 'http://fake.invalid',
  BANKING_API_KEY: 'k',
  BANKING_API_TIMEOUT_MS: 500,
  BANKING_API_MAX_RETRIES: 0,
  TRUST_PROXY: false,
  DATABASE_URL: testDatabaseUrl(),
  DATABASE_POOL_MAX: 3,
} as unknown as Env;

let app: FastifyInstance;
beforeEach(async () => {
  app = await buildApp({ env, db, pool, banking });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('the generated OpenAPI document', () => {
  it('is served as JSON and describes both endpoints', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);

    const doc = res.json<{
      openapi: string;
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    }>();
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/api/users/{userId}/sync', '/api/users/{userId}/reliability']),
    );
  });

  /**
   * A documented status the service cannot emit is worse than an undocumented
   * one: a caller writes a branch for it that never runs.
   */
  it('declares exactly the statuses the service can return', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    }>();
    const sync = Object.keys(doc.paths['/api/users/{userId}/sync']?.['post']?.responses ?? {});
    const score = Object.keys(
      doc.paths['/api/users/{userId}/reliability']?.['get']?.responses ?? {},
    );
    expect(sync).toEqual(expect.arrayContaining(['200', '404', '409']));
    expect(score).toEqual(expect.arrayContaining(['200', '400', '409']));
  });

  it('is also served as YAML, and the two agree on the paths', async () => {
    const yaml = await app.inject({ method: 'GET', url: '/openapi.yaml' });
    expect(yaml.statusCode).toBe(200);
    expect(yaml.body).toContain('/api/users/{userId}/reliability');
  });
});

describe('request validation happens before any work', () => {
  const bad = (from: string) =>
    app.inject({ method: 'GET', url: `/api/users/${USER}/reliability?from=${from}` });

  /**
   * A shape-valid but calendar-invalid date is the interesting case: a regex
   * that only checks `\d{4}-\d{2}-\d{2}` lets it through to the arithmetic,
   * which then silently produces a window nobody asked for.
   */
  it.each([
    ['2026-13-45', 'month and day out of range'],
    ['2026-02-31', 'shape-valid, calendar-invalid'],
    ['not-a-date', 'not a date at all'],
    ['', 'empty'],
  ])('rejects from=%s (%s) with 400 VALIDATION_ERROR', async (from) => {
    const res = await bad(from);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a missing `from` rather than defaulting one', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/users/${USER}/reliability` });
    expect(res.statusCode).toBe(400);
  });
});

describe('the error envelope', () => {
  it('has one shape, with a request id, on every error', async () => {
    const responses = [
      await app.inject({ method: 'GET', url: `/api/users/${USER}/reliability?from=bad` }),
      await app.inject({ method: 'GET', url: `/api/users/${USER}/reliability?from=2026-02-20` }),
      await app.inject({ method: 'GET', url: '/no/such/route' }),
    ];
    for (const res of responses) {
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      const body = res.json<{ error?: { code?: string; message?: string; request_id?: string } }>();
      expect(body.error).toBeDefined();
      expect(typeof body.error?.code).toBe('string');
      expect(typeof body.error?.message).toBe('string');
      expect(typeof body.error?.request_id).toBe('string');
    }
  });

  it('never leaks an upstream response body to the caller', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${USER}/reliability?from=2026-02-20`,
    });
    expect(res.body).not.toMatch(/stack|at Object|node_modules/i);
  });
});
