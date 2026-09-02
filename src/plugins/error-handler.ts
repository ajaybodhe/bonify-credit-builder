import type { FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { AppError } from '../lib/errors.js';

/**
 * Fastify's own errors, and several plugin errors, carry a `statusCode`. After
 * the type guards in the handler below, `error` has widened to `unknown`, so
 * read it defensively and never echo a nonsensical status back to the caller.
 */
function statusCodeOf(error: unknown): number {
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && status >= 400 && status <= 599 ? status : 500;
}

/**
 * One error shape on the wire, whatever went wrong:
 *   { error: { code, message, details?, request_id } }
 *
 * `request_id` is the thing that turns a screenshot from an analyst into a log
 * query, so it is on every error response including 500s.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;

    if (hasZodFastifySchemaValidationErrors(error)) {
      request.log.info({ err: error }, 'request validation failed');
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request failed validation',
          details: error.validation,
          request_id: requestId,
        },
      });
    }

    // A response that does not match its own schema is our bug, not the
    // caller's — log it loudly and do not leak the malformed payload.
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'response failed its own schema');
      return reply.code(500).send({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error', request_id: requestId },
      });
    }

    if (error instanceof AppError) {
      request.log.warn({ err: error, code: error.code }, 'handled application error');
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
          request_id: requestId,
        },
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.code(statusCodeOf(error)).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', request_id: requestId },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
        request_id: request.id,
      },
    }),
  );
}
