import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { NotFoundError, UnauthorizedError } from '../lib/errors.js';

/**
 * Vercel Cron calls with `Authorization: Bearer $CRON_SECRET`. The endpoint doesn't exist
 * (404) until a secret is configured, so it can't be triggered by anyone by accident.
 */
export function requireCronSecret(req: Request, _res: Response, next: NextFunction) {
  if (!env.CRON_SECRET) throw new NotFoundError('Not found', 'ROUTE_NOT_FOUND');

  const expected = Buffer.from(`Bearer ${env.CRON_SECRET}`);
  const received = Buffer.from(req.headers.authorization ?? '');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new UnauthorizedError('Invalid cron credentials', 'CRON_UNAUTHORIZED');
  }
  next();
}
