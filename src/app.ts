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

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(deps.env),
    // Off unless a proxy is in front: the rate limiter keys on client IP, and a
    // header anyone can rotate defeats it.
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

  // No version segment: the breaking change this API will face is a *changed*
  // scoring signal — same shape, different number. A `/v2` path cannot express that.
  await app.register(syncRoutes, { prefix: '/api' });
  await app.register(reliabilityRoutes, { prefix: '/api' });

  return app;
}
