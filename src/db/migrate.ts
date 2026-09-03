import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import { createDatabase } from './client.js';

/** Only what a migration needs — not the Banking API credentials. */
const migrationEnv = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(2),
});

const parsed = migrationEnv.safeParse(process.env);
if (!parsed.success) {
  console.error('Cannot migrate: DATABASE_URL is not set');
  process.exit(1);
}

const { db, close } = createDatabase(parsed.data as Env, { statementTimeoutMs: 0 });

try {
  await migrate(db, { migrationsFolder: './drizzle' });
  console.warn('migrations applied');
} finally {
  await close();
}
