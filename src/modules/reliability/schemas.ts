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
 * Bounded deliberately — the last place a model bug is caught. Zero essential
 * expenses makes the ratio `Infinity`, which `JSON.stringify` writes as `null`.
 */
export const metricsSchema = z.object({
  income_regularity: z.number().min(0).max(1),
  income_coverage_ratio: z.number().min(0),
  essential_payments_consistency: z.number().min(0).max(1),
  good_months: z.number().int().min(0).max(6),
  negative_balance_days: z.number().int().min(0),
  late_fee_events: z.number().int().min(0),
});

export const dataQualitySchema = z.object({
  completeness: z.enum(['complete', 'stale']),
  window_start: z.string(),
  window_end: z.string(),
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
  data_quality: dataQualitySchema,
  model_version: z.number().int(),
});

export type ReliabilityQuery = z.infer<typeof reliabilityQuerySchema>;
export type ReliabilityResponse = z.infer<typeof reliabilityResponseSchema>;
export type ScoreBand = z.infer<typeof scoreBandSchema>;
export type Metrics = z.infer<typeof metricsSchema>;
export type DataQualityResponse = z.infer<typeof dataQualitySchema>;
