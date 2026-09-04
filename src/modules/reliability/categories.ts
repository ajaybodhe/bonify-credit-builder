import { createHash } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type { BankingApiClient } from '../../banking/client.js';
import { merchantCategories, merchantCategoryVersions } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import type pg from 'pg';

/**
 * Refreshed by the sync path, read locally by scoring, never fetched inline. Never
 * overwritten: a differing hash mints a new version and keeps the old one, which
 * is what lets a score store `category_version` alone.
 */

export interface CategoryDictionary {
  version: number;
  essential: readonly string[];
  highRisk: readonly string[];
  savings: readonly string[];
  income: readonly string[];
  fees: readonly string[];
  fetchedAt: Date;
}

export class CategoryResolver {
  private readonly byVersion = new Map<number, CategoryDictionary>();

  constructor(
    private readonly db: Database,
    private readonly banking: BankingApiClient,
  ) {}

  /** Local only: a credit decision cannot inherit the Banking API’s availability. */
  async forVersion(version: number, client?: pg.PoolClient): Promise<CategoryDictionary> {
    const cached = this.byVersion.get(version);
    if (cached) return cached;

    const dictionary = await this.mustReadVersion(version, client);
    this.byVersion.set(version, dictionary);
    return dictionary;
  }

  async currentVersion(): Promise<number | null> {
    const [row] = await this.db
      .select({ version: merchantCategoryVersions.version })
      .from(merchantCategoryVersions)
      .orderBy(desc(merchantCategoryVersions.version))
      .limit(1);
    return row?.version ?? null;
  }

  async refreshFromUpstream(now: Date = new Date()): Promise<CategoryDictionary> {
    const fetched = await this.banking.listMerchantCategories();
    const sorted = [...fetched].sort((a, b) => a.code.localeCompare(b.code));
    const hash = createHash('sha256')
      .update(sorted.map((c) => `${c.code}|${c.group}|${c.name}`).join('\n'))
      .digest('hex');

    const [current] = await this.db
      .select()
      .from(merchantCategoryVersions)
      .orderBy(desc(merchantCategoryVersions.version))
      .limit(1);

    if (current?.contentHash === hash) {
      return this.mustReadVersion(current.version);
    }

    const version = (current?.version ?? 0) + 1;
    await this.db.transaction(async (tx) => {
      await tx
        .insert(merchantCategoryVersions)
        .values({ version, contentHash: hash, fetchedAt: now });
      await tx.insert(merchantCategories).values(
        sorted.map((c) => ({
          version,
          code: c.code,
          name: c.name,
          group: c.group,
        })),
      );
    });

    return this.mustReadVersion(version);
  }

  /**
   * The one reader. `client` is passed on the scoring path so the read joins the
   * caller's MVCC snapshot; without it the pool is fine, because a version's
   * rows never change once written.
   */
  private async readVersion(
    version: number,
    client?: pg.PoolClient,
  ): Promise<CategoryDictionary | null> {
    const rows = client
      ? (
          await client.query<{ code: string; group: string; fetched_at: Date }>(
            `SELECT c.code, c."group", v.fetched_at
               FROM merchant_categories c
               JOIN merchant_category_versions v USING (version)
              WHERE c.version = $1`,
            [version],
          )
        ).rows
      : await this.db
          .select({
            code: merchantCategories.code,
            group: merchantCategories.group,
            fetched_at: merchantCategoryVersions.fetchedAt,
          })
          .from(merchantCategories)
          .innerJoin(
            merchantCategoryVersions,
            eq(merchantCategories.version, merchantCategoryVersions.version),
          )
          .where(eq(merchantCategories.version, version));

    if (rows.length === 0) return null;

    const byGroup = (group: string) => rows.filter((r) => r.group === group).map((r) => r.code);
    return {
      version,
      essential: byGroup('essential'),
      highRisk: byGroup('high_risk'),
      savings: byGroup('savings'),
      income: byGroup('income'),
      fees: byGroup('fees'),
      fetchedAt: rows[0]?.fetched_at ?? new Date(0),
    };
  }

  /** A stored version with no entries is unusable, and the caller cannot proceed. */
  private async mustReadVersion(
    version: number,
    client?: pg.PoolClient,
  ): Promise<CategoryDictionary> {
    const dictionary = await this.readVersion(version, client);
    if (!dictionary) {
      throw new AppError(
        'CATEGORIES_UNAVAILABLE',
        503,
        `Merchant category dictionary version ${String(version)} is not stored locally. ` +
          'Dictionary versions are never deleted, so this means the sync that recorded ' +
          'it never persisted one.',
      );
    }
    return dictionary;
  }
}
