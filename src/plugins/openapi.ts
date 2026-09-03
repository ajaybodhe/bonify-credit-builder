import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Thin-File Credit Builder',
        description:
          'Syncs bank transaction data and computes an explainable Reliability Index (0-100).',
        version: '0.1.0',
      },
      servers: [{ url: '/', description: 'this instance' }],
      tags: [
        { name: 'sync', description: 'Ingestion from the Banking API' },
        { name: 'scoring', description: 'Reliability Index' },
        { name: 'ops', description: 'Health and readiness' },
      ],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.get(
    '/openapi.yaml',
    { schema: { tags: ['ops'], summary: "This service's OpenAPI 3.1 document (YAML)" } },
    (_req, reply) => {
      // Do NOT `await` reply.type(): a FastifyReply is thenable, so awaiting it parks
      // the handler until the response is sent. Instant deadlock.
      reply.type('text/yaml; charset=utf-8');
      return app.swagger({ yaml: true });
    },
  );

  app.get(
    '/openapi.json',
    { schema: { tags: ['ops'], summary: "This service's OpenAPI 3.1 document (JSON)" } },
    (_req, reply) => {
      reply.type('application/json; charset=utf-8');
      return app.swagger();
    },
  );
}
