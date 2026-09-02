import { defineConfig } from 'drizzle-kit';

// Migrations are generated into ./drizzle and committed. They are applied by
// `npm run db:migrate` (src/db/migrate.ts), never by drizzle-kit push, so that
// what runs in CI is byte-identical to what runs in production.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://credit:credit@localhost:5433/credit_builder',
  },
  strict: true,
  verbose: true,
});
