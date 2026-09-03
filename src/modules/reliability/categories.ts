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

    if (client) return this.readVersionOn(client, version);

    const [row] = await this.db
      .select()
      .from(merchantCategoryVersions)
      .where(eq(merchantCategoryVersions.version, version))
      .limit(1);
    const dictionary = row ? await this.readVersion(version, row.fetchedAt) : null;
    if (!dictionary) {
      throw new AppError(
        'CATEGORIES_UNAVAILABLE',
        503,
        `Merchant category dictionary version ${String(version)} is not stored locally. ` +
          'Dictionary versions are never deleted, so this means the sync that recorded ' +
          'it never persisted one.',
      );
    }
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
      return this.mustReadVersion(current.version, current.fetchedAt);
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

    return this.mustReadVersion(version, now);
  }

  private async readVersionOn(client: pg.PoolClient, version: number): Promise<CategoryDictionary> {
    const { rows } = await client.query<{ code: string; group: string; fetched_at: Date }>(
      `SELECT c.code, c."group", v.fetched_at
         FROM merchant_categories c
         JOIN merchant_category_versions v USING (version)
        WHERE c.version = $1`,
      [version],
    );
    if (rows.length === 0) {
      throw new AppError(
        'CATEGORIES_UNAVAILABLE',
        503,
        `Merchant category dictionary version ${String(version)} is not stored locally.`,
      );
    }
    const byGroup = (group: string) => rows.filter((r) => r.group === group).map((r) => r.code);
    const dictionary: CategoryDictionary = {
      version,
      essential: byGroup('essential'),
      highRisk: byGroup('high_risk'),
      savings: byGroup('savings'),
      income: byGroup('income'),
      fees: byGroup('fees'),
      fetchedAt: rows[0]?.fetched_at ?? new Date(0),
    };
    this.byVersion.set(version, dictionary);
    return dictionary;
  }

  private async readVersion(version: number, fetchedAt: Date): Promise<CategoryDictionary | null> {
    const rows = await this.db
      .select()
      .from(merchantCategories)
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
      fetchedAt,
    };
  }

  private async mustReadVersion(version: number, fetchedAt: Date): Promise<CategoryDictionary> {
    const d = await this.readVersion(version, fetchedAt);
    if (!d) throw new Error(`Merchant category version ${String(version)} has no entries`);
    return d;
  }
}
