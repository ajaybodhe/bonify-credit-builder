/**
 * Applies committed migrations from ./drizzle. Run by `npm run db:migrate`,
 * by CI before integration tests, and as a deploy step in production — the
 * same code path in all three, so a migration cannot pass locally and surprise
 * a release.
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import { createDatabase } from './client.js';

/**
 * Only what a migration needs.
 *
 * The full `loadEnv()` demands `BANKING_API_BASE_URL` and `BANKING_API_KEY`,
 * which this never calls. Requiring them would force a deploy to inject
 * upstream credentials into a job that has no business holding them — and
 * would fail the migration step of any environment that has not been given
 * them yet.
 */
const migrationEnv = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(2),
});

const parsed = migrationEnv.safeParse(process.env);
if (!parsed.success) {
  console.error('Cannot migrate: DATABASE_URL is not set');
  process.exit(1);
}

// 0 = no limit. An index build on a large table must not be killed mid-flight.
const { db, close } = createDatabase(parsed.data as Env, { statementTimeoutMs: 0 });

try {
  await migrate(db, { migrationsFolder: './drizzle' });
  console.warn('migrations applied');
} finally {
  await close();
}
