import { Agent, request } from 'undici';
import { UpstreamError } from '../lib/errors.js';
import { bankingApiRequests, bankingApiRetries } from '../telemetry/metrics.js';

/**
 * The single outbound HTTP path — nothing else calls `fetch`, enforced by a lint
 * rule. Retried: 5xx, the transient 4xx (408, 425, 429), transport failures.
 * Terminal: every other 4xx, since retrying a 401 only burns the rate limit.
 */
export interface HttpClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function route(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      if (segment === '') return segment;
      return STATIC_SEGMENTS.has(segment) ? segment : '{id}';
    })
    .join('/');
}

const STATIC_SEGMENTS = new Set([
  'users',
  'accounts',
  'transactions',
  'dictionaries',
  'merchant-categories',
  'health',
]);

export function createHttpClient(opts: HttpClientOptions) {
  const dispatcher = new Agent({
    connectTimeout: opts.timeoutMs,
    headersTimeout: opts.timeoutMs,
    bodyTimeout: opts.timeoutMs,
    keepAliveTimeout: 10_000,
  });

  const base = opts.baseUrl.replace(/\/+$/, '');

  async function get<T = unknown>(
    path: string,
    query?: Record<string, string | number>,
    /** Aborts the retry loop too: per-attempt timeouts bound one round trip. */
    signal?: AbortSignal,
  ): Promise<T> {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));

    let lastError: unknown;
    /** Per request: shared, one `Retry-After: 3600` would park unrelated retries. */
    let lastRetryAfter: number | undefined;

    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
      signal?.throwIfAborted();
      if (attempt > 0) await sleep(backoffMs(attempt, lastRetryAfter), signal);
      signal?.throwIfAborted();

      try {
        const res = await request(url, {
          method: 'GET',
          dispatcher,
          ...(signal && { signal }),
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            accept: 'application/json',
          },
        });

        bankingApiRequests.add(1, {
          'http.route': route(path),
          'http.status_class': `${String(Math.floor(res.statusCode / 100))}xx`,
        });

        if (res.statusCode >= 200 && res.statusCode < 300) {
          return (await res.body.json()) as T;
        }

        await res.body.text();

        if (!RETRYABLE_STATUS.has(res.statusCode)) {
          // Never put the upstream body in `details`: internal hostnames, ids, stack traces.
          throw new UpstreamError(`Banking API ${String(res.statusCode)} for ${path}`, {
            status: res.statusCode,
          });
        }

        bankingApiRetries.add(1, {
          'http.route': route(path),
          reason: res.statusCode === 429 ? '429' : '5xx',
        });
        lastRetryAfter = retryAfterMs(res.headers['retry-after']);
        lastError = new UpstreamError(`Banking API ${String(res.statusCode)} for ${path}`, {
          status: res.statusCode,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (err instanceof UpstreamError && hasTerminalStatus(err)) throw err;
        bankingApiRequests.add(1, { 'http.route': route(path), 'http.status_class': 'none' });
        bankingApiRetries.add(1, {
          'http.route': route(path),
          reason: isTimeout(err) ? 'timeout' : 'transport',
        });
        lastError = err;
        lastRetryAfter = undefined;
      }
    }

    throw new UpstreamError(
      `Banking API unreachable for ${path} after ${String(opts.maxRetries + 1)} attempts`,
      { cause: lastError instanceof Error ? lastError.message : String(lastError) },
    );
  }

  return { get, close: () => dispatcher.close() };
}

function hasTerminalStatus(err: UpstreamError): boolean {
  const status = (err.details as { status?: unknown } | undefined)?.status;
  return typeof status === 'number' && !RETRYABLE_STATUS.has(status);
}

function isTimeout(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.includes('TIMEOUT');
}

function backoffMs(attempt: number, retryAfter?: number): number {
  if (retryAfter !== undefined) return Math.min(retryAfter, MAX_RETRY_AFTER_MS);
  const ceiling = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  return Math.random() * ceiling;
}

function retryAfterMs(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 5_000;

const MAX_RETRY_AFTER_MS = 30_000;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });

export type HttpClient = ReturnType<typeof createHttpClient>;
