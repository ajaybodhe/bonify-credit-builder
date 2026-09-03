import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ReliabilityService } from './service.js';
import { DataQualityService } from './data-quality.js';
import {
  reliabilityParamsSchema,
  reliabilityQuerySchema,
  reliabilityResponseSchema,
} from './schemas.js';
import { errorResponseSchema } from '../../lib/http-schemas.js';

export const reliabilityRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new ReliabilityService(
    app.db,
    app.pool,
    app.categories,
    new DataQualityService(),
  );

  app.get(
    '/users/:userId/reliability',
    {
      schema: {
        tags: ['scoring'],
        summary: 'Compute the explainable Reliability Index from locally stored transactions',
        params: reliabilityParamsSchema,
        querystring: reliabilityQuerySchema,
        response: {
          200: reliabilityResponseSchema,
          400: errorResponseSchema.describe('VALIDATION_ERROR — `from` missing or malformed'),
          409: errorResponseSchema.describe(
            'SYNC_REQUIRED — synced data does not fully cover the requested window. ' +
              '`details` names the gap per account. Sync, then retry.',
          ),
          503: errorResponseSchema.describe(
            'CATEGORIES_UNAVAILABLE — no merchant category dictionary has ever been fetched. ' +
              'Component C is undefined without it, and guessing would produce a confident ' +
              'wrong score. Scoring never calls the Banking API, so this is decided from ' +
              'local state alone: sync to fetch one.',
          ),
        },
      },
    },
    async (req) => service.getReliability(req.params.userId, req.query.from),
  );
};
