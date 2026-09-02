import { z } from 'zod';
import { isoDateSchema } from '../../lib/http-schemas.js';

export const reliabilityParamsSchema = z.object({
  userId: z.string().min(1),
});

export const reliabilityQuerySchema = z.object({
  from: isoDateSchema.describe('End of the 6-calendar-month scoring window, inclusive'),
});

export const scoreBandSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);

/**
 * Bounded deliberately. These are not defensive noise: a response schema is the
 * last place a model bug can be caught before it becomes a number someone acts
 * on, and every bound here is an invariant the model already claims to hold.
 *
 * The coverage ratio is the one that matters most. Zero essential expenses
 * makes the ratio `Infinity`; `JSON.stringify` turns that into `null`, and the
 * response silently violates its own contract. Zod 4's `z.number()` already
 * rejects `Infinity` and `NaN` — no `.finite()` needed, and adding it is a
 * deprecated no-op — so the bare `.min(0)` is enough to make a regression loud.
 * The model is specified to award the 1.0x value in that case instead.
 */
export const metricsSchema = z.object({
  income_regularity: z.number().min(0).max(1),
  income_coverage_ratio: z.number().min(0),
  essential_payments_consistency: z.number().min(0).max(1),
  good_months: z.number().int().min(0).max(6),
  negative_balance_days: z.number().int().min(0),
  late_fee_events: z.number().int().min(0),
});

/**
 * Reported alongside every score. A consumer that ignores this field still gets
 * the brief's exact response shape.
 *
 * Note what it no longer has to express: partial coverage. A score is only ever
 * served on a window every account fully spans, so this describes the data
 * behind a *valid* score — its freshness, its breadth, the age of the category
 * dictionary — rather than warning that the score may be wrong.
 */
export const dataQualitySchema = z.object({
  /**
   * Only two values are reachable: a score is never served on incomplete
   * coverage — that is a `409 SYNC_REQUIRED`. `stale` is a freshness statement,
   * not a coverage one.
   */
  completeness: z.enum(['complete', 'stale']),
  window_start: z.string(),
  window_end: z.string(),
  /** Non-null on any served score, since coverage is a precondition. */
  covers_from: z.string().nullable(),
  covers_through: z.string().nullable(),
  accounts_total: z.number().int(),
  accounts_covering: z.number().int(),
  last_sync_at: z.string().nullable(),
  last_sync_status: z.string().nullable(),
  category_dictionary_age_hours: z.number().nullable(),
  warnings: z.array(z.string()),
});

export const reliabilityResponseSchema = z.object({
  user_id: z.string(),
  from: z.string(),
  currency: z.literal('EUR'),
  reliability_index: z.number().int().min(0).max(100),
  score_band: scoreBandSchema,
  metrics: metricsSchema,
  drivers: z.array(z.string()),
  /** Additive to the brief's shape — see dataQualitySchema. */
  data_quality: dataQualitySchema,
  /** Lets a consumer detect that the model changed under them. */
  model_version: z.number().int(),
});

export type ReliabilityQuery = z.infer<typeof reliabilityQuerySchema>;
export type ReliabilityResponse = z.infer<typeof reliabilityResponseSchema>;
export type ScoreBand = z.infer<typeof scoreBandSchema>;
export type Metrics = z.infer<typeof metricsSchema>;
export type DataQualityResponse = z.infer<typeof dataQualitySchema>;
