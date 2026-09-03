import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';
import type { Env } from '../config/env.js';

export type Database = ReturnType<typeof createDatabase>['db'];

pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value: string) => value);

/** `db:migrate` opts out: an index build must not be killed mid-flight. */
export interface DatabaseOptions {
  statementTimeoutMs?: number;
}

export function createDatabase(env: Env, options: DatabaseOptions = {}) {
  const statementTimeoutMs = options.statementTimeoutMs ?? 15_000;
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // `connectionTimeoutMillis` bounds only *acquiring* a connection.
    options: [
      `-c statement_timeout=${String(statementTimeoutMs)}`,
      '-c lock_timeout=5000',
      '-c idle_in_transaction_session_timeout=30000',
    ].join(' '),
  });

  const db = drizzle(pool, { schema, casing: 'snake_case' });

  return { db, pool, close: () => pool.end() };
}
