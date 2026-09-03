import type { LoggerOptions } from 'pino';
import type { Env } from '../config/env.js';

export function loggerOptions(env: Env): LoggerOptions {
  const base: LoggerOptions = {
    level: env.LOG_LEVEL,
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
     * Every URL carries a user id, so by default every access log line records who
     * was looked at. Redacted; `userId` is still logged where an operation needs it.
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

export interface Logger {
  debug(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export function anonymiseUrl(url: string): string {
  const [path, query] = url.split('?');
  const clean = (path ?? '')
    .split('/')
    .map((segment, i, all) =>
      i > 0 && (all[i - 1] === 'users' || all[i - 1] === 'accounts') ? '{id}' : segment,
    )
    .join('/');
  return query === undefined ? clean : `${clean}?${query}`;
}
