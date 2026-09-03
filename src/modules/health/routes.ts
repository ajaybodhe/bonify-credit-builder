import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['ops'],
        summary: 'Liveness probe',
        response: { 200: z.object({ status: z.literal('ok'), uptime_s: z.number() }) },
      },
    },
    () => ({ status: 'ok' as const, uptime_s: Math.round(process.uptime()) }),
  );

  app.get(
    '/ready',
    {
      schema: {
        tags: ['ops'],
        summary: 'Readiness probe — verifies the database is reachable',
        response: {
          200: z.object({ status: z.literal('ready'), database: z.literal('up') }),
          503: z.object({ status: z.literal('not_ready'), database: z.literal('down') }),
        },
      },
    },
    async (_req, reply) => {
      try {
        await app.db.execute(sql`select 1`);
        return { status: 'ready' as const, database: 'up' as const };
      } catch {
        return reply.code(503).send({ status: 'not_ready' as const, database: 'down' as const });
      }
    },
  );
};
