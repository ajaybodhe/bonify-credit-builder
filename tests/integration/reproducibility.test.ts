import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  categoryMappingForVersion,
  hashScoringInputs,
  hashTransactionSet,
  toScoringTransactions,
  transactionsAsOf,
} from '../../src/modules/reliability/reconstruct.js';
import { modelFor } from '../../src/modules/reliability/models/index.js';
import { classifyTransfers } from '../../src/modules/reliability/transfers.js';
import { testPool } from '../helpers/db.js';
import type { ScoringWindow } from '../../src/lib/date.js';

/** Can a past score be traced back to exactly the inputs that produced it? */
const pool = testPool();
afterAll(() => pool.end());

const USER = 'user_repro';
const WINDOW: ScoringWindow = {
  start: '2025-09-01',
  end: '2026-02-20',
  months: ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02'],
};

/** The instant a score was served. Everything after it must be invisible to it. */
const SCORED_AT = new Date('2026-02-21T12:00:00Z');
const LATER = '2026-03-15T09:00:00Z';

async function seedAccount() {
  await pool.query(
    `INSERT INTO accounts (id, user_id, currency) VALUES ('acc_r', $1, 'EUR')
     ON CONFLICT (id) DO NOTHING`,
    [USER],
  );
}

async function txn(
  id: string,
  bookedAt: string,
  amount: string,
  category: string,
  opts: { ingestedAt?: string; isCredit?: boolean; status?: string } = {},
) {
  await pool.query(
    `INSERT INTO transactions
       (id, account_id, user_id, booked_at, amount, currency, category, is_credit,
        status, content_hash, revision, ingested_at, updated_at)
     VALUES ($1,'acc_r',$2,$3,$4,'EUR',$5,$6,$7,'h0',1,$8,$8)`,
    [
      id,
      USER,
      bookedAt,
      amount,
      category,
      opts.isCredit ?? false,
      opts.status ?? 'active',
      opts.ingestedAt ?? '2026-01-01T00:00:00Z',
    ],
  );
}

/** Applies an upstream amendment the way sync would: archive the prior state, then update. */
async function amend(
  id: string,
  changes: Partial<{ amount: string; category: string; booked_at: string; status: string }>,
  detectedAt: string,
) {
  const sets = Object.entries(changes).map(([k], i) => `${k} = $${String(i + 2)}`);
  await pool.query(
    `INSERT INTO transaction_revisions
       (id, transaction_id, revision, content_hash, previous, detected_at)
     SELECT $1, t.id, t.revision + 1, t.content_hash, to_jsonb(t), $3
       FROM transactions t WHERE t.id = $2`,
    [`rev_${id}_${detectedAt}`, id, detectedAt],
  );
  await pool.query(
    `UPDATE transactions SET ${sets.join(', ')}, revision = revision + 1 WHERE id = $1`,
    [id, ...Object.values(changes)],
  );
}

async function categoryVersion(version: number, mapping: Record<string, string>) {
  await pool.query(
    `INSERT INTO merchant_category_versions (version, content_hash)
     VALUES ($1, $2) ON CONFLICT (version) DO NOTHING`,
    [version, `hash_v${String(version)}`],
  );
  for (const [code, group] of Object.entries(mapping)) {
    await pool.query(
      `INSERT INTO merchant_categories (version, code, name, "group")
       VALUES ($1, $2, $3, $4) ON CONFLICT (version, code) DO NOTHING`,
      [version, code, `cat ${code}`, group],
    );
  }
}

const asOfScored = async () => {
  const c = await pool.connect();
  try {
    return await transactionsAsOf(c, USER, WINDOW, SCORED_AT);
  } finally {
    c.release();
  }
};

/** A fixed dictionary: this suite is about rebuilding inputs, not resolving them. */
const MAPPING = {
  version: 1,
  essential: ['5411', '6513'],
  highRisk: ['7995'],
  savings: ['6540'],
  income: ['9001'],
  fees: ['6012'],
  fetchedAt: new Date('2026-02-21T00:00:00Z'),
  stale: false,
  source: 'database' as const,
};

/**
 * Fixture dictionary versions, deliberately far above anything a real refresh
 * will mint. This suite deletes them between cases, and dictionary versions
 * that ever served a score must never be deleted — so the numbers it reuses
 * must be ones no score can be pinned to.
 */
const V_OLD = 900001;
const V_NEW = 900002;
const clearFixtureVersions = async () => {
  await pool.query('DELETE FROM merchant_categories WHERE version IN ($1,$2)', [V_OLD, V_NEW]);
  await pool.query('DELETE FROM merchant_category_versions WHERE version IN ($1,$2)', [
    V_OLD,
    V_NEW,
  ]);
};

afterAll(clearFixtureVersions);

beforeEach(async () => {
  await pool.query('DELETE FROM transaction_revisions WHERE transaction_id LIKE $1', ['t_%']);
  await pool.query('DELETE FROM transactions WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM accounts WHERE user_id = $1', [USER]);
  await clearFixtureVersions();
  await seedAccount();
});

/**
 * Each row is something that happened AFTER the score was served. In every
 * case the reconstruction must return the world as it was, so the fingerprint
 * still matches.
 */
describe('the scored transaction set survives later change', () => {
  const cases: {
    name: string;
    mutate: () => Promise<void>;
    expectIds: string[];
  }[] = [
    {
      name: 'nothing changes',
      mutate: async () => Promise.resolve(),
      expectIds: ['t_a', 't_b'],
    },
    {
      name: 'a new transaction arrives later',
      mutate: () => txn('t_late', '2026-02-01', '-30.00', '5411', { ingestedAt: LATER }),
      expectIds: ['t_a', 't_b'],
    },
    {
      name: 'an amount is amended later',
      mutate: () => amend('t_a', { amount: '-999.00' }, LATER),
      expectIds: ['t_a', 't_b'],
    },
    {
      name: 'a category is corrected later',
      mutate: () => amend('t_a', { category: '9001' }, LATER),
      expectIds: ['t_a', 't_b'],
    },
    {
      name: 'a transaction is reversed later',
      mutate: () => amend('t_b', { status: 'reversed' }, LATER),
      expectIds: ['t_a', 't_b'],
    },
    {
      name: 'a booking date is moved out of the window later',
      mutate: () => amend('t_b', { booked_at: '2026-07-01' }, LATER),
      expectIds: ['t_a', 't_b'],
    },
    {
      name: 'several changes at once',
      mutate: async () => {
        await amend('t_a', { amount: '-1.00' }, LATER);
        await txn('t_late2', '2026-01-05', '-12.00', '5411', { ingestedAt: LATER });
      },
      expectIds: ['t_a', 't_b'],
    },
  ];

  it.each(cases)('$name', async ({ mutate, expectIds }) => {
    await txn('t_a', '2025-10-05', '-42.00', '5411');
    await txn('t_b', '2026-01-12', '1200.00', '9001', { isCredit: true });
    const before = await asOfScored();
    const hashBefore = hashTransactionSet(before);

    await mutate();

    const after = await asOfScored();
    expect(after.map((t) => t.id).sort()).toEqual(expectIds);
    // The fingerprint is what an auditor compares against the snapshot.
    expect(hashTransactionSet(after)).toBe(hashBefore);
  });

  it('and the CURRENT view does reflect the change — the rollback is not a no-op', async () => {
    await txn('t_a', '2025-10-05', '-42.00', '5411');
    await txn('t_b', '2026-01-12', '1200.00', '9001', { isCredit: true });
    const scored = hashTransactionSet(await asOfScored());

    await amend('t_a', { amount: '-999.00' }, LATER);

    const c = await pool.connect();
    let now;
    try {
      now = await transactionsAsOf(c, USER, WINDOW, new Date('2027-01-01T00:00:00Z'));
    } finally {
      c.release();
    }
    expect(hashTransactionSet(now)).not.toBe(scored);
  });
});

/**
 * A whole ACCOUNT connected after a score was served, carrying transactions
 * backdated into that score's window.
 *
 * This is the worst shape of late arrival: the rows are not corrections to
 * anything we had, they are activity we never saw, dated to a period we have
 * already scored and published. The guard is the same one that covers a late
 * transaction — `ingested_at` records when we FIRST saw a row and is never
 * rewritten by a re-sync — but the blast radius is larger, so it is worth
 * proving separately rather than assuming the account case falls out of the
 * transaction case.
 */
describe('an account connected after the score was served', () => {
  const lateAccount = async () => {
    await pool.query(
      `INSERT INTO accounts (id, user_id, currency) VALUES ('acc_late', $1, 'EUR')
       ON CONFLICT (id) DO NOTHING`,
      [USER],
    );
    // Booked well inside the scored window; ingested long after it closed.
    for (const [id, date, amount, category, credit] of [
      ['t_new_a', '2025-10-02', '2500.00', '9001', true],
      ['t_new_b', '2025-11-14', '-800.00', '6513', false],
      ['t_new_c', '2026-01-20', '-45.00', '5411', false],
    ] as const) {
      await pool.query(
        `INSERT INTO transactions
           (id, account_id, user_id, booked_at, amount, currency, category, is_credit,
            status, content_hash, revision, ingested_at, updated_at)
         VALUES ($1,'acc_late',$2,$3,$4,'EUR',$5,$6,'active','h0',1,$7,$7)`,
        [id, USER, date, amount, category, credit, LATER],
      );
    }
  };

  it('is invisible to the score that was already served', async () => {
    await txn('t_a', '2025-10-05', '-42.00', '5411');
    await txn('t_b', '2026-01-12', '1200.00', '9001', { isCredit: true });
    const hashBefore = hashTransactionSet(await asOfScored());

    await lateAccount();

    const after = await asOfScored();
    expect(after.map((t) => t.id).sort()).toEqual(['t_a', 't_b']);
    expect(hashTransactionSet(after)).toBe(hashBefore);
  });

  it('but does change the CURRENT view, so the next score legitimately differs', async () => {
    // The published score is not retro-corrected — it stays reproducible as
    // served. The new activity shows up in the NEXT score, as a new snapshot.
    await txn('t_a', '2025-10-05', '-42.00', '5411');
    await txn('t_b', '2026-01-12', '1200.00', '9001', { isCredit: true });
    const asServed = hashTransactionSet(await asOfScored());

    await lateAccount();

    const c = await pool.connect();
    let now;
    try {
      now = await transactionsAsOf(c, USER, WINDOW, new Date('2027-01-01T00:00:00Z'));
    } finally {
      c.release();
    }
    expect(now.map((t) => t.id).sort()).toEqual(['t_a', 't_b', 't_new_a', 't_new_b', 't_new_c']);
    expect(hashTransactionSet(now)).not.toBe(asServed);
  });

  /**
   * The rows must be excluded because we had not SEEN them, not because they
   * belong to an account we had not seen. Nothing in the rebuild filters on the
   * account list — which is what makes a re-sync of the same account safe.
   */
  it('excludes them on ingest time alone, not on account membership', async () => {
    await txn('t_a', '2025-10-05', '-42.00', '5411');
    await lateAccount();
    // One row on the late account, backdated AND ingested before the score.
    await pool.query(
      `INSERT INTO transactions
         (id, account_id, user_id, booked_at, amount, currency, category, is_credit,
          status, content_hash, revision, ingested_at, updated_at)
       VALUES ('t_new_early','acc_late',$1,'2025-12-01','-10.00','EUR','5411',false,
               'active','h0',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
      [USER],
    );

    const after = await asOfScored();
    expect(after.map((t) => t.id).sort()).toEqual(['t_a', 't_new_early']);
  });
});

/** The gap every other test in this file steps over. */
describe('a rebuild reproduces the LIVE fingerprint, not merely another rebuild', () => {
  it('spells money identically whether read as a column or out of jsonb', async () => {
    await txn('t_money', '2025-10-05', '-42.50', '5411');

    const client = await pool.connect();
    try {
      // Typed columns, as the scoring path reads them. Must select every field
      // `hashTransactionSet` digests, or this compares a live row against a
      // rebuild of a different shape and fails for the wrong reason.
      const live = await client.query<{
        id: string;
        account_id: string;
        booked_at: string;
        amount: string;
        currency: string;
        category: string | null;
        is_credit: boolean;
      }>(
        `SELECT id, account_id, booked_at::text, amount, currency, category, is_credit
           FROM transactions WHERE id = 't_money'`,
      );
      const liveHash = hashTransactionSet(live.rows as never);

      // Exactly what an audit does: rebuild as of the scoring instant.
      const rebuiltHash = hashTransactionSet(
        await transactionsAsOf(client, USER, WINDOW, SCORED_AT),
      );

      expect(rebuiltHash).toBe(liveHash);
    } finally {
      client.release();
    }
  });

  it('keeps the trailing zero a jsonb round trip would drop', async () => {
    await txn('t_money', '2025-10-05', '-42.50', '5411');
    const client = await pool.connect();
    try {
      const [rebuilt] = await transactionsAsOf(client, USER, WINDOW, SCORED_AT);
      // "-42.5" would hash differently from the "-42.50" scoring saw.
      expect(rebuilt?.amount).toBe('-42.50');
    } finally {
      client.release();
    }
  });
});

describe('the category mapping survives later regrouping', () => {
  const V1 = { '5411': 'essential', '5812': 'discretionary', '9001': 'income' };

  const cases: {
    name: string;
    v2: Record<string, string>;
  }[] = [
    { name: 'a code is regrouped', v2: { ...V1, '5812': 'essential' } },
    { name: 'a code is added', v2: { ...V1, '6513': 'essential' } },
    { name: 'a code is removed', v2: { '5411': 'essential', '9001': 'income' } },
  ];

  it.each(cases)('$name — the earlier version still resolves as it was', async ({ v2 }) => {
    await categoryVersion(V_OLD, V1);
    const c1 = await pool.connect();
    let before;
    try {
      before = await categoryMappingForVersion(c1, V_OLD);
    } finally {
      c1.release();
    }

    await categoryVersion(V_NEW, v2);

    const c2 = await pool.connect();
    try {
      expect(await categoryMappingForVersion(c2, V_OLD)).toEqual(before);
      expect(await categoryMappingForVersion(c2, V_NEW)).toEqual(v2);
    } finally {
      c2.release();
    }
  });

  it('refuses a version that does not exist rather than falling back to the latest', async () => {
    await categoryVersion(V_OLD, V1);
    const c = await pool.connect();
    try {
      await expect(categoryMappingForVersion(c, 99)).rejects.toThrow(/never deleted/);
    } finally {
      c.release();
    }
  });
});

describe('the fingerprint', () => {
  // Re-derivation itself needs the model, which is still stubbed.
  /**
   * The whole claim, end to end: rebuild the inputs a snapshot names, re-run the
   * model version it names, and land on the number it recorded.
   *
   * This is only possible because the snapshot stores the balance anchor too.
   * The resilience component walks backwards from it, and it cannot be
   * recovered afterwards — `accounts.current_balance` is overwritten by every
   * sync and the provider does not reconcile it against the rows it publishes.
   */
  it('re-running the recorded model version over the rebuilt inputs reproduces the score', async () => {
    await txn('t_a', '2025-10-05', '-42.00', '5411');
    await txn('t_b', '2026-01-12', '1200.00', '9001', { isCredit: true });

    const balances = { acc_r: '900.00' };
    const rebuilt = await asOfScored();
    const model = modelFor(1);
    const asScored = toScoringTransactions(rebuilt);
    const first = model.compute({
      window: WINDOW,
      transactions: asScored,
      transfers: classifyTransfers(asScored, new Map(), new Set()),
      categories: MAPPING,
      closingBalances: balances,
    });

    // The world moves on: a later amendment and a later arrival.
    await amend('t_a', { amount: '-999.00' }, LATER);
    await txn('t_late_r', '2026-02-01', '-30.00', '5411', { ingestedAt: LATER });

    const again = await asOfScored();
    const againScored = toScoringTransactions(again);
    const second = model.compute({
      window: WINDOW,
      transactions: againScored,
      transfers: classifyTransfers(againScored, new Map(), new Set()),
      categories: MAPPING,
      closingBalances: balances,
    });

    expect(second.reliability_index).toBe(first.reliability_index);
    expect(second.metrics).toEqual(first.metrics);
    expect(hashScoringInputs(again, balances)).toBe(hashScoringInputs(rebuilt, balances));
  });

  /**
   * The balance anchor moves independently of the transactions. If the
   * fingerprint ignored it, a restated balance would score differently under an
   * unchanged hash — and because the hash is also the snapshot dedupe key, the
   * new score would be served while the stored snapshot kept the old one.
   */
  it('changes when only the balance anchor moves', async () => {
    await txn('t_a', '2025-10-05', '-42.00', '5411');
    const set = await asOfScored();
    expect(hashScoringInputs(set, { acc_r: '900.00' })).not.toBe(
      hashScoringInputs(set, { acc_r: '250.00' }),
    );
  });

  it('is stable across balance key order, and sensitive to an added account', async () => {
    await txn('t_a', '2025-10-05', '-42.00', '5411');
    const set = await asOfScored();
    expect(hashScoringInputs(set, { a: '1.00', b: '2.00' })).toBe(
      hashScoringInputs(set, { b: '2.00', a: '1.00' }),
    );
    expect(hashScoringInputs(set, { a: '1.00' })).not.toBe(
      hashScoringInputs(set, { a: '1.00', b: '2.00' }),
    );
  });
});
