import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { collectMetrics, pointWith } from '../helpers/metrics.js';
import { testPool } from '../helpers/db.js';
// Type-only: erased before runtime, so these do not load the modules early and
// bind their instruments to a no-op meter.
import type * as ClaimModule from '../../src/modules/sync/claim.js';
import type * as HttpModule from '../../src/banking/http.js';

/**
 * A metric that is declared but never emitted is worse than no metric: the
 * dashboard renders a flat line and the flat line reads as "healthy". These
 * tests assert the instruments actually fire, with the attributes the alerts
 * are written against.
 *
 * Integration tier: the emissions worth protecting sit on the far side of a
 * real boundary — a reclaim is a Postgres UPDATE, a retry is an HTTP round
 * trip. Asserting them against mocks would only prove the mock was called.
 */
const pool = testPool();
afterAll(() => pool.end());

describe('sync.reclaims', () => {
  const USER = 'user_metrics_reclaim';
  afterEach(() => pool.query('DELETE FROM sync_runs WHERE user_id = $1', [USER]));

  /**
   * The only signal that a process died mid-sync. The request that died never
   * returned a status, so no HTTP metric can show it — the crash is visible
   * only in the cleanup that follows it.
   */
  it('counts a stale run reclaimed by the next claim', async () => {
    const m = collectMetrics();
    try {
      const { SYNC_RECLAIM_AFTER_MS, withSyncRun } = await m.load<typeof ClaimModule>(
        '../../src/modules/sync/claim.js',
      );

      await pool.query(
        `INSERT INTO sync_runs (id, user_id, status, started_at)
         VALUES ('run_m_stale', $1, 'running', now() - make_interval(secs => $2))`,
        [USER, SYNC_RECLAIM_AFTER_MS / 1000 + 60],
      );

      expect(await m.total('sync.reclaims')).toBe(0);
      await withSyncRun(pool, USER, 'api', () => Promise.resolve());
      expect(await m.total('sync.reclaims')).toBe(1);
    } finally {
      await m.shutdown();
    }
  });

  it('stays flat on the ordinary path, so any movement is a real crash', async () => {
    const m = collectMetrics();
    try {
      const { withSyncRun } = await m.load<typeof ClaimModule>('../../src/modules/sync/claim.js');
      await withSyncRun(pool, USER, 'api', () => Promise.resolve());
      await withSyncRun(pool, USER, 'api', () => Promise.resolve());
      expect(await m.total('sync.reclaims')).toBe(0);
    } finally {
      await m.shutdown();
    }
  });
});

describe('banking metrics', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  const serve = async (handler: (n: number) => { status: number; body?: string }) => {
    let calls = 0;
    server = createServer((_req, res) => {
      const { status, body } = handler(++calls);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body ?? '{}');
    });
    const started = server;
    await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', resolve));
    const { port } = started.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${String(port)}`, calls: () => calls };
  };

  it('labels requests by route and status class', async () => {
    const m = collectMetrics();
    const { createHttpClient } = await m.load<typeof HttpModule>('../../src/banking/http.js');
    const { baseUrl } = await serve(() => ({ status: 200, body: '{"ok":true}' }));
    const client = createHttpClient({ baseUrl, apiKey: 'k', timeoutMs: 2_000, maxRetries: 2 });
    try {
      await client.get('/accounts/acc_1001_chk/transactions');
      const points = await m.read('banking.requests');
      // Every non-static segment is stripped: one series per endpoint. An
      // allow-list, because a deny-list of id shapes will always miss one.
      expect(
        pointWith(points, {
          'http.route': '/accounts/{id}/transactions',
          'http.status_class': '2xx',
        })?.value,
      ).toBe(1);
    } finally {
      await client.close();
      await m.shutdown();
    }
  });

  it('counts a retried 5xx by reason, and the eventual success separately', async () => {
    const m = collectMetrics();
    const { createHttpClient } = await m.load<typeof HttpModule>('../../src/banking/http.js');
    const { baseUrl } = await serve((n) => (n < 3 ? { status: 503 } : { status: 200 }));
    const client = createHttpClient({ baseUrl, apiKey: 'k', timeoutMs: 2_000, maxRetries: 3 });
    try {
      await client.get('/health');
      expect(pointWith(await m.read('banking.retries'), { reason: '5xx' })?.value).toBe(2);
      const requests = await m.read('banking.requests');
      expect(pointWith(requests, { 'http.status_class': '5xx' })?.value).toBe(2);
      expect(pointWith(requests, { 'http.status_class': '2xx' })?.value).toBe(1);
    } finally {
      await client.close();
      await m.shutdown();
    }
  });

  it('distinguishes a 429 from a 5xx, because they need different responses', async () => {
    const m = collectMetrics();
    const { createHttpClient } = await m.load<typeof HttpModule>('../../src/banking/http.js');
    const { baseUrl } = await serve((n) => (n < 2 ? { status: 429 } : { status: 200 }));
    const client = createHttpClient({ baseUrl, apiKey: 'k', timeoutMs: 2_000, maxRetries: 3 });
    try {
      await client.get('/health');
      expect(pointWith(await m.read('banking.retries'), { reason: '429' })?.value).toBe(1);
    } finally {
      await client.close();
      await m.shutdown();
    }
  });

  /**
   * A timeout produces no status code at all, so a request counter keyed only
   * on HTTP status would drop it silently — and timeouts are precisely what the
   * retry budget is spent on.
   */
  it('records a timeout, which has no status code to be counted under', async () => {
    const m = collectMetrics();
    const { createHttpClient } = await m.load<typeof HttpModule>('../../src/banking/http.js');
    let hang: NodeJS.Timeout | undefined;
    server = createServer(() => {
      hang = setTimeout(() => undefined, 30_000); // never responds
    });
    const started = server;
    await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', resolve));
    const { port } = started.address() as AddressInfo;
    const client = createHttpClient({
      baseUrl: `http://127.0.0.1:${String(port)}`,
      apiKey: 'k',
      timeoutMs: 150,
      maxRetries: 1,
    });
    try {
      await expect(client.get('/health')).rejects.toThrow(/unreachable/);
      expect(
        pointWith(await m.read('banking.requests'), {
          'http.status_class': 'none',
        })?.value,
      ).toBe(2);
      expect(pointWith(await m.read('banking.retries'), { reason: 'timeout' })?.value).toBe(2);
    } finally {
      if (hang) clearTimeout(hang);
      await client.close();
      await m.shutdown();
    }
  });

  it('does not retry — or count a retry for — a terminal 4xx', async () => {
    const m = collectMetrics();
    const { createHttpClient } = await m.load<typeof HttpModule>('../../src/banking/http.js');
    const { baseUrl, calls } = await serve(() => ({ status: 404 }));
    const client = createHttpClient({ baseUrl, apiKey: 'k', timeoutMs: 2_000, maxRetries: 3 });
    try {
      await expect(client.get('/accounts/acc_missing/transactions')).rejects.toThrow();
      expect(calls()).toBe(1);
      expect(await m.total('banking.retries')).toBe(0);
      expect(
        pointWith(await m.read('banking.requests'), { 'http.status_class': '4xx' })?.value,
      ).toBe(1);
    } finally {
      await client.close();
      await m.shutdown();
    }
  });
});
