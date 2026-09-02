import { defineConfig } from 'vitest/config';

/**
 * Four tiers, separated by **what they need to run** and **what they can
 * prove**. The distinction is not pedantry: a suite you cannot run in two
 * seconds on every save is a suite you stop running.
 *
 *   unit         no I/O at all               ~200ms   every save
 *   integration  one real dependency         ~5s      pre-push, CI
 *   e2e          whole app, real Postgres    ~30s     CI
 *   contract     the LIVE Banking API        network  manual / scheduled
 *
 * `include` is defined ONLY per project. Setting it at the root as well makes
 * every project inherit it and run every file.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    projects: [
      {
        // Pure functions. No database, no network, no clock, no filesystem.
        // The scoring model lives here because that is what makes it auditable.
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
        },
      },
      {
        // Exactly ONE real boundary per file: the database, or the Banking
        // client against a mock HTTP layer. Never the whole app — when one of
        // these fails it should be obvious which boundary broke.
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          hookTimeout: 60_000,
          fileParallelism: false, // shared Postgres state
        },
      },
      {
        // The whole app via app.inject(), real Postgres, stubbed Banking API.
        // These prove properties that span layers — above all, that a score
        // served today can be reproduced and explained tomorrow.
        extends: true,
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        // Asserts our ASSUMPTIONS about the real upstream still hold: cursor
        // shape, ordering guarantees, field names. Hits the network, so it is
        // opt-in and never gates a pull request — it is an early-warning alarm,
        // not a correctness gate.
        extends: true,
        test: {
          name: 'contract',
          include: ['tests/contract/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/types/**', 'src/index.ts', 'src/telemetry/register.ts'],
    },
  },
});
