import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import type { Env } from './config/env.js';
import type pg from 'pg';
import type { Database } from './db/client.js';
import type { BankingApiClient } from './banking/client.js';
import { loggerOptions } from './lib/logger.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerOpenApi } from './plugins/openapi.js';
import { healthRoutes } from './modules/health/routes.js';
import { syncRoutes } from './modules/sync/routes.js';
import { reliabilityRoutes } from './modules/reliability/routes.js';
import { CategoryResolver } from './modules/reliability/categories.js';

export interface AppDeps {
  env: Env;
  db: Database;
  pool: pg.Pool;
  banking: BankingApiClient;
}

/**
 * Builds a fully wired but unlistening Fastify instance. Tests use
 * `app.inject()` against this; `index.ts` is the only thing that binds a port.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(deps.env),
    /**
     * Whether `X-Forwarded-*` can be believed is a property of the DEPLOYMENT,
     * not of the code. Trusting it unconditionally means anyone can claim any
     * client IP, and the rate limiter keys on that IP — so a rotating header
     * defeats it entirely. Off unless the operator states a proxy is in front.
     */
    trustProxy: deps.env.TRUST_PROXY,
    requestIdHeader: 'x-request-id',
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('env', deps.env);
  app.decorate('db', deps.db);
  app.decorate('pool', deps.pool);
  app.decorate('banking', deps.banking);
  app.decorate('categories', new CategoryResolver(deps.db, deps.banking));

  // Fastify's own OTel plugin, rather than the deprecated
  // @opentelemetry/instrumentation-fastify. Registered only when telemetry is
  // switched on, so a dev run stays free of exporter machinery.
  if (process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) {
    const { FastifyOtelInstrumentation } = await import('@fastify/otel');
    const otel = new FastifyOtelInstrumentation({ registerOnInitialization: false });
    await app.register(otel.plugin());
  }

  await app.register(helmet);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  registerErrorHandler(app);
  await registerOpenApi(app);

  await app.register(healthRoutes);

  // One mount point, exactly as the brief specifies. No version segment.
  //
  // Deliberate: the breaking change this API will actually face is not shaped
  // like a URL. Adding a scoring signal is additive; *changing* one produces a
  // different score from identical input — breaking, with the JSON shape
  // unchanged. A `/v2` path cannot express that, so shipping one now would be
  // ceremony that solves nothing. See docs/discussion-topics.md for where
  // versioning goes when it is actually needed.
  await app.register(syncRoutes, { prefix: '/api' });
  await app.register(reliabilityRoutes, { prefix: '/api' });

  return app;
}
