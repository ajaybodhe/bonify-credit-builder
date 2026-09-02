import { z } from 'zod';

/**
 * Wire shapes shared by every module.
 *
 * The error envelope lives here rather than in a feature module because it is a
 * service-wide contract produced by `plugins/error-handler.ts`. It previously
 * sat in `modules/sync/schemas.ts`, which meant the reliability module imported
 * from the sync module for something neither owns — a dependency that says
 * nothing true about how the two relate.
 */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    request_id: z.string(),
  }),
});

/**
 * A real calendar date, not merely a ten-character string.
 *
 * `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)` accepts `2026-13-45` and
 * `2026-02-31`. Those reach the window arithmetic and produce a silently wrong
 * window rather than a 400 — the caller gets a score for six months that do not
 * exist. `z.iso.date()` rejects them at the boundary, which is what the
 * boundary is for.
 */
export const isoDateSchema = z.iso.date();
