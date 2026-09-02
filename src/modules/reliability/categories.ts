import { createHash } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type { BankingApiClient } from '../../banking/client.js';
import { merchantCategories, merchantCategoryVersions } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import type pg from 'pg';

/**
 * Resolves which merchant categories count as essential / high-risk.
 *
 * Why this is not just a call to the Banking API on every scoring request:
 *
 * 1. **Availability coupling.** Scoring is otherwise a pure, database-only
 *    read. Fetching the dictionary inline would make a credit decision fail
 *    because an unrelated upstream service is down — for data that changes
 *    perhaps monthly.
 * 2. **Latency.** A network round trip per score, for a payload measured in
 *    kilobytes and shared by every user.
 * 3. **Reproducibility.** If the dictionary can change between two scoring
 *    calls, two identical transaction sets can score differently with no record
 *    of why. Persisting it makes the dictionary part of the audited input.
 *
 * The strategy is therefore three-tiered, degrading rather than failing:
 *
 *   in-process cache (TTL)  →  `merchant_categories` table  →  Banking API
 *
 * A refresh failure is never fatal while a persisted copy exists; the scoring
 * response reports the dictionary's age so a stale one is visible rather than
 * silent.
 *
 * ## Versioning
 *
 * The dictionary is never overwritten. A refresh hashes what upstream returned
 * and compares it with the current version: identical, nothing happens;
 * different, a new version is written and the old one kept forever.
 *
 * That is what lets a score store `category_version` alone. Without it, a code
 * moving from `discretionary` to `essential` would silently change what every
 * earlier score meant — the numbers would stay, but the reason for them would
 * be gone. Old versions may never be deleted, for the same reason a released
 * model file may never be deleted.
 */

/** How long the in-process copy is trusted before revalidating against the DB. */
/** Beyond this we still serve, but flag the dictionary as stale in the response. */

export interface CategoryDictionary {
  /**
   * Identifies this exact mapping in `merchant_category_versions`.
   *
   * A score records this number and nothing else about categories — the
   * mapping is never copied into the snapshot, exactly as the model is not.
   */
  version: number;
  /** Merchant category codes by group, straight from the upstream dictionary. */
  essential: readonly string[];
  highRisk: readonly string[];
  savings: readonly string[];
  income: readonly string[];
  fees: readonly string[];
  /** When this dictionary was last successfully fetched from the Banking API. */
  fetchedAt: Date;
}

export class CategoryResolver {
  /**
   * Resolved dictionaries by version.
   *
   * Unbounded on purpose and safe: a version is immutable by construction — a
   * changed dictionary mints a new row rather than updating one — and versions
   * are minted at most once per upstream change, so this holds a handful of
   * entries for the life of the process. Without it a single score reads the
   * whole dictionary twice, once for scoring and once for data quality.
   */
  private readonly byVersion = new Map<number, CategoryDictionary>();

  constructor(
    private readonly db: Database,
    private readonly banking: BankingApiClient,
  ) {}

  /**
   * Resolves one specific version from local storage. Never touches the
   * network — this is the scoring path's only entry point, so a credit decision
   * cannot inherit the Banking API's availability.
   */
  async forVersion(version: number, client?: pg.PoolClient): Promise<CategoryDictionary> {
    const cached = this.byVersion.get(version);
    if (cached) return cached;

    // When the caller hands us their client we read on THEIR transaction, so
    // this observes the same instant as every other read feeding the score.
    // Version rows are immutable, so a separate handle would be benign today —
    // but "every read sees one instant" should be true, not nearly true.
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

  /** The newest version held locally, or null if none has ever been fetched. */
  async currentVersion(): Promise<number | null> {
    const [row] = await this.db
      .select({ version: merchantCategoryVersions.version })
      .from(merchantCategoryVersions)
      .orderBy(desc(merchantCategoryVersions.version))
      .limit(1);
    return row?.version ?? null;
  }

  /**
   * Called by the sync path, which is already talking to the Banking API.
   *
   * Mints a new version only when the content hash differs from the current
   * one — upstream returning the same dictionary must not create a version, or
   * the table grows once per sync and version numbers stop meaning anything.
   */
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
      // Unchanged. Touch nothing — a new version here would be a lie about
      // when the mapping last changed.
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

  /** Reads one version on a caller-supplied client, joining their snapshot. */
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

  /** One stored version, or null if it has no entries. */
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
