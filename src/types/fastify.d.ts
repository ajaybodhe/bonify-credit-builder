import type pg from 'pg';
import type { Database } from '../db/client.js';
import type { BankingApiClient } from '../banking/client.js';
import type { CategoryResolver } from '../modules/reliability/categories.js';
import type { Env } from '../config/env.js';

/** Decorated rather than module singletons, so a test can stub them. */
declare module 'fastify' {
  interface FastifyInstance {
    env: Env;
    db: Database;
    pool: pg.Pool;
    banking: BankingApiClient;
    /** ONE for the process: two instances each memo separately and never warm. */
    categories: CategoryResolver;
  }
}

export {};
