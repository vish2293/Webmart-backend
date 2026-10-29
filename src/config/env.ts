import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  MONGO_URI: z
    .string()
    .min(1)
    // `host//db` makes MongoDB use "/db" as the database name and every query fails.
    .refine((uri) => !/^mongodb(\+srv)?:\/\/[^/]+\/\//.test(uri), {
      message: 'MONGO_URI has "//" before the database name; use a single "/"',
    }),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z
    .string()
    .regex(/^\d+[smhd]$/, 'JWT_EXPIRES_IN must look like 15m, 12h or 7d')
    .default('7d'),
  CORS_ORIGINS: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  RAZORPAY_KEY_ID: z
    .string()
    .regex(/^rzp_(test|live)_\w+$/, 'RAZORPAY_KEY_ID must start with rzp_'),
  RAZORPAY_KEY_SECRET: z.string().min(1),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),
  /** Unpaid online orders are cancelled (and their stock released) after this long. */
  ORDER_PAYMENT_WINDOW_MINUTES: z.coerce
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .default(30),
  /** Enables GET /api/cron/expire-orders (Vercel Cron). Leave unset to keep it disabled. */
  CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 characters').optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Logger depends on env, so report config errors directly and stop.
  console.error('Invalid environment configuration:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
