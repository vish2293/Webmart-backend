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
  /** Stripe is optional: without both keys the "Stripe" payment method is simply not offered. */
  STRIPE_SECRET_KEY: z
    .string()
    .regex(/^sk_(test|live)_\w+$/, 'STRIPE_SECRET_KEY must start with sk_test_ or sk_live_')
    .optional(),
  /** Signing secret of the webhook endpoint (Dashboard > Developers > Webhooks), starts with whsec_. */
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .regex(/^whsec_\w+$/, 'STRIPE_WEBHOOK_SECRET must start with whsec_')
    .optional(),
  /** Unpaid online orders are cancelled (and their stock released) after this long. */
  ORDER_PAYMENT_WINDOW_MINUTES: z.coerce
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .default(30),
  /** Enables GET /api/cron/expire-orders (Vercel Cron). Leave unset to keep it disabled. */
  CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 characters').optional(),
  /** Resend API key. Without it, emails are written to the log instead of being sent. */
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(3).default('WebMart <onboarding@resend.dev>'),
  /** Where the storefront lives, for links in emails. Defaults to the first CORS origin. */
  CLIENT_URL: z.url().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const parsed = envSchema
  .refine((config) => Boolean(config.STRIPE_SECRET_KEY) === Boolean(config.STRIPE_WEBHOOK_SECRET), {
    message: 'Set both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET, or neither',
    path: ['STRIPE_WEBHOOK_SECRET'],
  })
  .safeParse(process.env);

if (!parsed.success) {
  // Logger depends on env, so report config errors directly and stop.
  console.error('Invalid environment configuration:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = {
  ...parsed.data,
  CLIENT_URL: (parsed.data.CLIENT_URL ?? parsed.data.CORS_ORIGINS[0] ?? '').replace(/\/$/, ''),
};
export const isProduction = env.NODE_ENV === 'production';
