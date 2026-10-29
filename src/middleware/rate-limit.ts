import type { Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

// ponytail: in-memory counters are per process; with several replicas each enforces its own
// limit. Switch to a shared store (e.g. rate-limit-redis) when scaling out.

const limitedMessage = {
  message: 'Too many requests, please try again later',
  code: 'RATE_LIMITED',
};

const baseOptions = {
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: limitedMessage,
} as const;

/** Broad per-IP ceiling for the whole API. */
export const apiRateLimit = rateLimit({ ...baseOptions, windowMs: 5 * 60_000, limit: 300 });

/** Login/register: slows down password guessing. */
export const authRateLimit = rateLimit({
  ...baseOptions,
  windowMs: 15 * 60_000,
  limit: 20,
  message: { ...limitedMessage, message: 'Too many attempts, please try again later' },
});

/** Keyed by the authenticated user, so one account can't spam behind many IPs. */
export function perUserRateLimit(limitPerMinute: number) {
  return rateLimit({
    ...baseOptions,
    windowMs: 60_000,
    limit: limitPerMinute,
    keyGenerator: (req: Request) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
  });
}
