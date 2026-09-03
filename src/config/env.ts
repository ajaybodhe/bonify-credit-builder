import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  BANKING_API_BASE_URL: z.url(),
  BANKING_API_KEY: z.string().min(1),
  BANKING_API_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  BANKING_API_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  // No sync-history knob: how far back to look is discovered from `data_range`.

  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  // No SCORING_MODEL_VERSION either: configurable, a snapshot could record a
  // version that never ran — the one claim the audit trail must make trustworthy.
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
