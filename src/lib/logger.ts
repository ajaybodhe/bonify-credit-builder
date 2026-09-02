import type { LoggerOptions } from 'pino';
import type { Env } from '../config/env.js';

/**
 * Pino options handed to Fastify. Pretty output in development only; JSON lines
 * everywhere else so logs stay greppable and ingestible.
 */
export function loggerOptions(env: Env): LoggerOptions {
  const base: LoggerOptions = {
    level: env.LOG_LEVEL,
    // Never let a bearer token reach a log sink.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.BANKING_API_KEY',
        '*.DATABASE_URL',
      ],
      censor: '[redacted]',
    },
    /**
     * Access logs carry the URL, and every URL here contains a user id — so by
     * default every log line is a record of who was looked at, retained for as
     * long as the log sink keeps it. The id is replaced with a placeholder;
     * `userId` is still logged deliberately where a specific operation needs
     * it, which keeps that a decision rather than a side effect.
     */
    serializers: {
      req(request: { method: string; url: string; routeOptions?: { url?: string } }) {
        return {
          method: request.method,
          url: anonymiseUrl(request.url),
        };
      },
    },
  };

  if (env.NODE_ENV !== 'development') return base;

  return {
    ...base,
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
    },
  };
}

/**
 * The slice of the Fastify logger that services depend on.
 *
 * Narrow on purpose: a service should be able to log without taking a
 * dependency on Fastify, and a test should be able to pass a plain object.
 */
export interface Logger {
  debug(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Replaces path segments that are user or account identifiers. */
export function anonymiseUrl(url: string): string {
  const [path, query] = url.split('?');
  const clean = (path ?? '')
    .split('/')
    .map((segment, i, all) =>
      // The segment AFTER a collection name is that collection's id.
      i > 0 && (all[i - 1] === 'users' || all[i - 1] === 'accounts') ? '{id}' : segment,
    )
    .join('/');
  return query === undefined ? clean : `${clean}?${query}`;
}
