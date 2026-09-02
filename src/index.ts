/**
 * Process entrypoint: build dependencies, start listening, and shut down
 * cleanly. Everything testable lives in app.ts.
 */
import { loadEnv } from './config/env.js';
import { createDatabase } from './db/client.js';
import { BankingApiClient } from './banking/client.js';
import { buildApp } from './app.js';
// Started by --import ./dist/telemetry/register.js; we only own the flush.
import { stopTelemetry } from './telemetry/otel.js';

const env = loadEnv();
const { db, pool, close: closeDb } = createDatabase(env);
const banking = new BankingApiClient(env);
const app = await buildApp({ env, db, pool, banking });

// Drain in-flight requests before dropping connections, so a rolling deploy
// does not turn into a burst of 502s.
async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await banking.close();
    await closeDb();
    await stopTelemetry();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void shutdown(signal));
}

try {
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
