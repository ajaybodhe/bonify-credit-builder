import { describe, expect, it, beforeAll } from 'vitest';

/**
 * Contract tests — these hit the LIVE Banking API.
 *
 * They do not test our code. They test the assumptions our code is built on,
 * and they exist because those assumptions are load-bearing and invisible:
 *
 *  - if `next_cursor` became an opaque token, our "never persist a cursor"
 *    reasoning would need revisiting
 *  - if ordering became stable and date-sorted, cursor resume would become safe
 *    and incremental sync could get cheaper
 *  - if a field were renamed, sync would produce plausible scores from nothing
 *
 * Each of those is a silent failure in production and an obvious failure here.
 *
 * Opt-in, because they need network and are not deterministic in the way a unit
 * test is:  npm run test:contract
 *
 * They deliberately do NOT gate pull requests. A red build caused by someone
 * else's outage teaches people to ignore red builds. Run them on a schedule and
 * alert on failure instead.
 */

const BASE = process.env['BANKING_API_BASE_URL'] ?? '';
const KEY = process.env['BANKING_API_KEY'] ?? '';
const AUTH = { Authorization: `Bearer ${KEY}` };

const canRun = BASE.length > 0 && KEY.length > 0;
const maybe = canRun ? describe : describe.skip;

// Contract tests are the one place a bare fetch is correct: the point is to
// bypass our own client and observe the upstream directly.
// eslint-disable-next-line no-restricted-syntax
const get = (path: string) => fetch(`${BASE}${path}`, { headers: AUTH });

maybe('Banking API contract', () => {
  beforeAll(() => {
    if (!canRun) throw new Error('BANKING_API_BASE_URL and BANKING_API_KEY must be set');
  });

  it('discovery lists the endpoints we depend on', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { endpoints: { path: string }[] };
    const paths = body.endpoints.map((e) => e.path);
    expect(paths).toContain('/users/:userId/accounts');
    expect(paths).toContain('/dictionaries/merchant-categories');
  });

  it('accounts are wrapped in { accounts: [...] } with the fields we read', async () => {
    const res = await get('/users/user_1001/accounts');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: Record<string, unknown>[] };
    expect(Array.isArray(body.accounts)).toBe(true);
    expect(Object.keys(body.accounts[0] ?? {})).toEqual(
      expect.arrayContaining(['id', 'user_id', 'type', 'currency', 'balance']),
    );
  });

  it('transactions use date / merchant_category_code / merchant_name', async () => {
    const res = await get('/accounts/acc_1001_chk/transactions?from=2025-09-01&to=2026-02-20');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { transactions: Record<string, unknown>[] };
    const keys = Object.keys(body.transactions[0] ?? {});
    // The names our schema depends on. A rename here is a silent scoring bug.
    expect(keys).toEqual(expect.arrayContaining(['id', 'account_id', 'amount', 'date', 'type']));
    expect(keys).not.toContain('booked_at');
  });

  it('still requires from/to — our client must always supply them', async () => {
    const res = await get('/accounts/acc_1001_chk/transactions');
    expect(res.status).toBe(400);
  });

  it('next_cursor is still a base64 offset, not an opaque token', async () => {
    const res = await get('/accounts/acc_1001_chk/transactions?from=2025-09-01&to=2026-02-20');
    const body = (await res.json()) as { next_cursor: string | null };
    expect(body.next_cursor).toBeTruthy();
    const decoded: unknown = JSON.parse(Buffer.from(body.next_cursor!, 'base64').toString('utf8'));
    expect(decoded).toHaveProperty('offset');
  });

  /**
   * The assumption the whole resume strategy rests on. If this ever FAILS —
   * i.e. the offset becomes stable across ranges — that is good news, and the
   * sync strategy can be revisited.
   */
  it('the same offset yields different rows when `to` changes', async () => {
    const cursor = Buffer.from(JSON.stringify({ offset: 15 })).toString('base64');
    const [a, b] = await Promise.all([
      get(`/accounts/acc_1001_chk/transactions?from=2025-09-01&to=2026-02-20&cursor=${cursor}`),
      get(`/accounts/acc_1001_chk/transactions?from=2025-09-01&to=2026-06-30&cursor=${cursor}`),
    ]);
    const idsOf = async (r: Response) =>
      ((await r.json()) as { transactions: { id: string }[] }).transactions.map((t) => t.id);
    expect(await idsOf(a)).not.toEqual(await idsOf(b));
  });

  /**
   * Sync's default range is derived from this, since accounts carry no
   * opened-at date. If the provider stopped publishing it, sync would have no
   * principled lower bound to ask for.
   */
  it('discovery still publishes a data_range to bound how far back we ask', async () => {
    const res = await get('/');
    const body = (await res.json()) as { data_range?: { from: string; to: string } };
    expect(body.data_range?.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.data_range?.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  /** If this ever appears, docs/architecture-design.md §4.5 is revisitable: we could fetch only what changed. */
  it('transactions still carry NO updated_at field', async () => {
    const res = await get('/accounts/acc_1001_chk/transactions?from=2025-09-01&to=2026-02-20');
    const body = (await res.json()) as { transactions: Record<string, unknown>[] };
    const keys = Object.keys(body.transactions[0] ?? {});
    expect(keys).not.toContain('updated_at');
    expect(keys).not.toContain('modified_at');
  });

  it('accounts still carry NO opened-at date', async () => {
    const res = await get('/users/user_1001/accounts');
    const body = (await res.json()) as { accounts: Record<string, unknown>[] };
    const keys = Object.keys(body.accounts[0] ?? {});
    expect(keys).not.toContain('opened_at');
    expect(keys).not.toContain('created_at');
  });

  it('category groups still cover the ones scoring depends on', async () => {
    const res = await get('/dictionaries/merchant-categories');
    const body = (await res.json()) as { categories: { group: string }[] };
    const groups = new Set(body.categories.map((c) => c.group));
    for (const required of ['essential', 'high_risk', 'savings', 'income', 'fees']) {
      expect(groups).toContain(required);
    }
  });
});
