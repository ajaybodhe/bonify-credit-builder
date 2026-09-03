import { z } from 'zod';

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    request_id: z.string(),
  }),
});

/** A real date: a shape regex accepts `2026-02-31` and silently shifts the window. */
export const isoDateSchema = z.iso.date();
