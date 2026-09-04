import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { BankingApiClient } from '../../src/banking/client.js';
import type { Env } from '../../src/config/env.js';
import type { Database } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import { testDatabaseUrl, testPool } from '../helpers/db.js';

/**
 * Integration tier: the readiness probe's one real boundary is the database.
 *
 * Endpoint behaviour for /sync and /reliability deliberately does NOT live
 * here — those span the whole app and belong in tests/e2e/.
 */
const pool = testPool();
afterAll(() => pool.end());

const env = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  BANKING_API_BASE_URL: 'http://fake.invalid',
  BANKING_API_KEY: 'k',
  DATABASE_URL: testDatabaseUrl(),
  DATABASE_POOL_MAX: 2,
} as unknown as Env;

const banking = {} as unknown as BankingApiClient;

async function appWith(p: pg.Pool) {
  const db: Database = drizzle(p, { schema });
  return buildApp({ env, db, pool: p, banking });
}

describe('readiness', () => {
  it('GET /ready returns 200 when the database is reachable', async () => {
    const app = await appWith(pool);
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  /**
   * The probe has to actually reach the database. A readiness check that
   * reports ready while the pool is dead takes the whole replica set with it.
   */
  it('GET /ready returns 503 when the database is unreachable', async () => {
    // A pool pointed at a closed port: connecting fails, so the probe must fail.
    const dead = new pg.Pool({
      connectionString: 'postgres://nobody@127.0.0.1:1/none',
      connectionTimeoutMillis: 500,
    });
    const app = await appWith(dead);
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
      await dead.end().catch(() => undefined);
    }
  });

  it('GET /health returns 200 without touching the database', async () => {
    // Liveness must not depend on a dependency, or a database blip restarts
    // every healthy process in the fleet.
    const dead = new pg.Pool({
      connectionString: 'postgres://nobody@127.0.0.1:1/none',
      connectionTimeoutMillis: 500,
    });
    const app = await appWith(dead);
    try {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ status: string }>().status).toBe('ok');
    } finally {
      await app.close();
      await dead.end().catch(() => undefined);
    }
  });
});
