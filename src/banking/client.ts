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

export interface DataRange {
  from: string;
  to: string;
}

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

  /** The only bound on how far back to sync: there is no account-opened date. */
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
      // Permanent: as an upstream failure it would look like a retryable outage.
      if (err instanceof UpstreamError && upstreamStatus(err) === 404) {
        throw new NotFoundError(`No such user upstream: ${userId}`);
      }
      throw err;
    }
  }

  /** The cursor never leaves this generator: an offset, void once `to` moves. */
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

  async listMerchantCategories(): Promise<MerchantCategory[]> {
    const body = await this.http.get('/dictionaries/merchant-categories');
    return merchantCategoriesResponseSchema.parse(body).categories;
  }

  close(): Promise<void> {
    return this.http.close();
  }
}
