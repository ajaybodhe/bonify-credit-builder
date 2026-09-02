import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { syncParamsSchema, syncResponseSchema } from './schemas.js';
import { errorResponseSchema } from '../../lib/http-schemas.js';
import { SyncService } from './service.js';

export const syncRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new SyncService(app.db, app.banking, app.pool, app.categories, app.log);

  app.post(
    '/users/:userId/sync',
    {
      schema: {
        tags: ['sync'],
        summary: 'Fetch accounts and transactions from the Banking API and store them locally',
        description:
          'Idempotent. Fetches the whole range the Banking API publishes and dedupes by ' +
          'content hash, so upstream amendments are detected rather than skipped. At most one ' +
          'sync runs per user at a time.',
        params: syncParamsSchema,
        // Failure modes are part of the contract, not a comment. Declaring them
        // means a generated client handles 409 and 502 instead of treating
        // every non-200 as an unknown error.
        response: {
          200: syncResponseSchema,
          404: errorResponseSchema.describe('USER_NOT_FOUND — unknown to the Banking API'),
          409: errorResponseSchema.describe('SYNC_IN_PROGRESS — a sync is already running'),
          502: errorResponseSchema.describe('UPSTREAM_UNAVAILABLE — the Banking API failed'),
        },
      },
    },
    async (req) => service.syncUser(req.params.userId),
  );
};
