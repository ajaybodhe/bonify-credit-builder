import { z } from 'zod';

/**
 * Environment is parsed once, at boot, and fails loudly. A service that starts
 * with a missing BANKING_API_KEY and only discovers it on the first sync is
 * strictly worse than one that refuses to start.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  BANKING_API_BASE_URL: z.url(),
  BANKING_API_KEY: z.string().min(1),
  BANKING_API_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  BANKING_API_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  // NOTE: there is deliberately no sync-history knob. A sync covers the whole
  // range the provider publishes in its `data_range`, so how far back to look is
  // discovered rather than configured — see docs/architecture-design.md §4.5.

  /**
   * Set only when the service genuinely sits behind a proxy that overwrites
   * `X-Forwarded-For`. Left off, the rate limiter keys on the real socket
   * address and a spoofed header cannot move it.
   */
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  // NOTE: there is deliberately no SCORING_MODEL_VERSION here. The model
  // version is a property of the CODE (`VERSION` in `models/v1.ts`), not of the
  // deployment. Making it configurable would let a snapshot record a version
  // that never ran, which is precisely the claim the audit trail exists to make
  // trustworthy.
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
