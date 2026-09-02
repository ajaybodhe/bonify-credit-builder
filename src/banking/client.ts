import type { Env } from '../config/env.js';
import { createHttpClient, type HttpClient } from './http.js';
import { NotFoundError, UpstreamError } from '../lib/errors.js';
import {
  accountsResponseSchema,
  merchantCategoriesResponseSchema,
  transactionsPageSchema,
  type BankingAccount,
  type BankingTransaction,
  type MerchantCategory,
} from './types.js';

/** Global bounds of the data this provider holds, from `GET /`. */
export interface DataRange {
  from: string;
  to: string;
}

/**
 * Typed façade over the Banking API. Paths and shapes verified against its
 * OpenAPI document — see tests/fixtures/banking-openapi.yaml.
 *
 *   GET /                                    discovery, no auth
 *   GET /users/{userId}/accounts             → { accounts: [...] }
 *   GET /accounts/{id}/transactions?from&to&cursor → { transactions, next_cursor }
 *   GET /dictionaries/merchant-categories    → { categories: [...] }
 *
 * Every response is validated at this boundary. Loose on unknown fields —
 * upstream may add some — and strict on the fields we score with, so a renamed
 * field fails loudly here rather than producing a confident wrong score.
 */
/** `UpstreamError.details.status`, without trusting its shape. */
function upstreamStatus(err: UpstreamError): number | undefined {
  const status = (err.details as { status?: unknown } | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
}

export class BankingApiClient {
  private readonly http: HttpClient;
  private dataRange: DataRange | undefined;

  constructor(
    env: Env,
    http: HttpClient = createHttpClient({
      baseUrl: env.BANKING_API_BASE_URL,
      apiKey: env.BANKING_API_KEY,
      timeoutMs: env.BANKING_API_TIMEOUT_MS,
      maxRetries: env.BANKING_API_MAX_RETRIES,
    }),
  ) {
    this.http = http;
  }

  /**
   * `GET /` — the discovery endpoint, which publishes the span of data the
   * provider holds. This is the only bound on how far back to sync: accounts
   * carry no opened-at date, so there is nothing per-account to discover.
   *
   * Memoised for the process lifetime; the range is static.
   */
  async getDataRange(): Promise<DataRange> {
    if (this.dataRange) return this.dataRange;
    const body = await this.http.get<{ data_range?: { from?: string; to?: string } }>('/');
    const from = body.data_range?.from;
    const to = body.data_range?.to;
    if (!from || !to) {
      throw new UpstreamError('Discovery endpoint did not publish a data_range', { body });
    }
    this.dataRange = { from, to };
    return this.dataRange;
  }

  async listAccounts(userId: string, signal?: AbortSignal): Promise<BankingAccount[]> {
    try {
      const body = await this.http.get(
        `/users/${encodeURIComponent(userId)}/accounts`,
        undefined,
        signal,
      );
      return accountsResponseSchema.parse(body).accounts;
    } catch (err) {
      // A 404 here is permanent and specific: no such user. Reported as an
      // upstream failure it would be indistinguishable from an outage, so
      // callers would retry a request that can never succeed.
      if (err instanceof UpstreamError && upstreamStatus(err) === 404) {
        throw new NotFoundError(`No such user upstream: ${userId}`);
      }
      throw err;
    }
  }

  /**
   * Walks one account's transactions for a date range, yielding a page at a
   * time until `next_cursor` is null.
   *
   * The cursor never leaves this generator. It is a positional offset into the
   * result set defined by (accountId, from, to), so it is meaningless once `to`
   * moves — persisting one would silently skip and duplicate rows.
   *
   * Yielding pages rather than accumulating keeps peak memory at one page
   * regardless of history length.
   */
  async *streamTransactions(
    accountId: string,
    range: { from: string; to: string },
    signal?: AbortSignal,
  ): AsyncGenerator<BankingTransaction[]> {
    let cursor: string | undefined;
    do {
      const body = await this.http.get(
        `/accounts/${encodeURIComponent(accountId)}/transactions`,
        { from: range.from, to: range.to, ...(cursor ? { cursor } : {}) },
        signal,
      );
      const page = transactionsPageSchema.parse(body);
      yield page.transactions;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }

  /** Source of truth for essential / high_risk / savings / income / fees. */
  async listMerchantCategories(): Promise<MerchantCategory[]> {
    const body = await this.http.get('/dictionaries/merchant-categories');
    return merchantCategoriesResponseSchema.parse(body).categories;
  }

  close(): Promise<void> {
    return this.http.close();
  }
}
