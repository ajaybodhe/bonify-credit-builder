import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';
import type { Env } from '../config/env.js';

export type Database = ReturnType<typeof createDatabase>['db'];

// Postgres returns numeric as a string by default in node-postgres, which is
// what we want — see the note in schema.ts. Assert it rather than assume it.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value: string) => value);

/**
 * Migrations are the one legitimate long-running statement: a backfill or an
 * index build on a large table can far exceed the request-path budget, and
 * killing it halfway is worse than waiting. `db:migrate` opts out.
 */
export interface DatabaseOptions {
  statementTimeoutMs?: number;
}

export function createDatabase(env: Env, options: DatabaseOptions = {}) {
  const statementTimeoutMs = options.statementTimeoutMs ?? 15_000;
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    // Waiting for a connection from the pool, and reaping idle ones.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    /**
     * The database deserves the same treatment as the Banking API: a call that
     * never returns must fail rather than hang. Client-side timeouts do not
     * cover this — `connectionTimeoutMillis` only bounds *acquiring* a
     * connection, so a query that runs forever holds one forever.
     *
     *   statement_timeout                     no single query outlives this
     *   lock_timeout                          never queue behind a lock
     *                                         indefinitely
     *   idle_in_transaction_session_timeout   an abandoned open transaction
     *                                         holds its locks and blocks
     *                                         vacuum; this reaps it
     *
     * Set per-connection via `options` so they apply to every session without
     * needing a server-side default.
     */
    options: [
      `-c statement_timeout=${String(statementTimeoutMs)}`,
      '-c lock_timeout=5000',
      '-c idle_in_transaction_session_timeout=30000',
    ].join(' '),
  });

  const db = drizzle(pool, { schema, casing: 'snake_case' });

  return { db, pool, close: () => pool.end() };
}
