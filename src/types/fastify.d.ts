import type pg from 'pg';
import type { Database } from '../db/client.js';
import type { BankingApiClient } from '../banking/client.js';
import type { CategoryResolver } from '../modules/reliability/categories.js';
import type { Env } from '../config/env.js';

/**
 * Dependencies are decorated onto the Fastify instance rather than imported as
 * module singletons, so a test can build an app with a stub Banking client and
 * a throwaway database without touching module state.
 */
declare module 'fastify' {
  interface FastifyInstance {
    env: Env;
    db: Database;
    /** Raw pool: claim transactions and the scoring read snapshot need a real client. */
    pool: pg.Pool;
    banking: BankingApiClient;
    /**
     * ONE resolver for the process. Two instances each keep their own
     * per-version memo, so the cache never warms and the dictionary is read
     * again on every request that happens to hit the other one.
     */
    categories: CategoryResolver;
  }
}

export {};
