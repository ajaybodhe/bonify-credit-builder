import { Agent, request } from 'undici';
import { UpstreamError } from '../lib/errors.js';
import { bankingApiRequests, bankingApiRetries } from '../telemetry/metrics.js';

/**
 * The single outbound HTTP path. Nothing else in the service calls `fetch` —
 * enforced by a lint rule in eslint.config.js — so timeouts, retries and
 * backoff are configured in exactly one place.
 *
 * Retry policy: retry only what is safe to retry.
 *
 *   retried    5xx, plus the 4xx that describe a transient condition rather
 *              than a bad request — 408 Request Timeout, 425 Too Early,
 *              429 Too Many Requests — and transport errors/timeouts.
 *   terminal   every other 4xx. Retrying a 401 only burns the rate limit, and
 *              a 400 stays wrong however many times it is repeated.
 *
 * Backoff is exponential with FULL JITTER: fixed backoff synchronises every
 * client into retry waves against an already-struggling upstream.
 *
 * On 429 the upstream's `Retry-After` header takes precedence over the computed
 * delay when present — the server knows its own recovery window better than we
 * do. (The Mock Banking API does not currently send it; the handling exists so
 * a real provider is honoured.)
 */
export interface HttpClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Endpoint label, with ids stripped: `/accounts/acc_1/transactions` is one
 * series, not one per account. Unbounded label cardinality is how a metrics
 * bill and a Prometheus instance both fall over. */
function route(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      if (segment === '') return segment;
      // Anything that is not a known, fixed path word is treated as an
      // identifier. An allow-list rather than a pattern: user ids are
      // caller-supplied and arbitrary, so a deny-list of shapes will always
      // miss one — and a missed id becomes an unbounded metric label carrying
      // a personal identifier into the metrics backend.
      return STATIC_SEGMENTS.has(segment) ? segment : '{id}';
    })
    .join('/');
}

/** Every fixed segment this client ever requests. Anything else is an id. */
const STATIC_SEGMENTS = new Set([
  'users',
  'accounts',
  'transactions',
  'dictionaries',
  'merchant-categories',
  'health',
]);

export function createHttpClient(opts: HttpClientOptions) {
  // Typed as Agent, not Dispatcher: `close()` below needs Agent, and widening
  // then casting back is a round trip through the type system for nothing.
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
    /**
     * Aborts the request AND the retry loop.
     *
     * Per-attempt timeouts bound one round trip; they say nothing about a
     * sequence of them. The sync's deadline lives above this layer, so without
     * a signal reaching in, a single page could outlast it — retries plus
     * backoff — and the run would still be inside the page when a competing
     * claimant reclaimed its slot.
     */
    signal?: AbortSignal,
  ): Promise<T> {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));

    let lastError: unknown;
    /**
     * Carries a server-supplied `Retry-After` from one attempt into the next.
     *
     * PER REQUEST, deliberately. Shared across the client it would be poison:
     * one upstream `Retry-After: 3600` would make every later retry in the
     * process — for unrelated users, on unrelated endpoints — sleep an hour,
     * holding a worker and a `running` sync row for the whole time.
     */
    let lastRetryAfter: number | undefined;

    // `<=` because maxRetries counts RETRIES, not attempts.
    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
      // Checked before sleeping AND before dispatching: a signal that fires
      // mid-backoff must not buy the caller another attempt.
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

        // Drain the body even on failure, or the connection cannot be reused.
        // Read and discarded: it must not reach the client (see below).
        await res.body.text();

        if (!RETRYABLE_STATUS.has(res.statusCode)) {
          // `details` is serialised into the API response, so the upstream's
          // body must not go in it — it can carry internal hostnames, ids or a
          // stack trace. The status is enough for a caller to act on; the body
          // is drained above so the connection can be reused, and discarded.
          throw new UpstreamError(`Banking API ${String(res.statusCode)} for ${path}`, {
            status: res.statusCode,
          });
        }

        bankingApiRetries.add(1, {
          'http.route': route(path),
          reason: res.statusCode === 429 ? '429' : '5xx',
        });
        // The server knows its own recovery window better than our backoff
        // does — but only up to a point. An unbounded value parks the caller
        // for as long as upstream says, so honour it under our own ceiling.
        lastRetryAfter = retryAfterMs(res.headers['retry-after']);
        lastError = new UpstreamError(`Banking API ${String(res.statusCode)} for ${path}`, {
          status: res.statusCode,
        });
      } catch (err) {
        // An abort is the caller withdrawing, not upstream failing. Retrying it
        // would be retrying against our own deadline.
        if (signal?.aborted) throw err;
        // A terminal status is already an UpstreamError with a status; anything
        // else is a transport failure or timeout, which is retryable.
        if (err instanceof UpstreamError && hasTerminalStatus(err)) throw err;
        // No status: the request never completed. Timeouts are the interesting
        // half — they are what the retry budget is really spent on.
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

/**
 * Exponential backoff with FULL jitter: a uniform draw from [0, base·2^n].
 *
 * Not "base·2^n plus a bit" — the whole interval is randomised, because partial
 * jitter still leaves every client clustered near the same delay and they
 * arrive back together against an upstream that is already struggling.
 */
/** undici surfaces timeouts by code, not by type. */
function isTimeout(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.includes('TIMEOUT');
}

function backoffMs(attempt: number, retryAfter?: number): number {
  if (retryAfter !== undefined) return Math.min(retryAfter, MAX_RETRY_AFTER_MS);
  const ceiling = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  return Math.random() * ceiling;
}

/** `Retry-After` is either delay-seconds or an HTTP date. */
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

/**
 * Ceiling on a server-supplied `Retry-After`. Without it, one hostile or
 * mistaken header parks a request — and the sync run holding it — indefinitely.
 */
const MAX_RETRY_AFTER_MS = 30_000;

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
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
