import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';
import { verifyAccessToken } from '../modules/users/token.js';
import { findAuthenticatedUser } from '../modules/users/users.service.js';
import type { AuthenticatedUser } from '../modules/users/users.types.js';

export async function authenticateRequest(req: Request, _res: Response, next: NextFunction) {
  const [scheme, token] = req.headers.authorization?.split(' ') ?? [];
  if (scheme !== 'Bearer' || !token) {
    throw new UnauthorizedError('Not authorized, no token', 'AUTH_TOKEN_MISSING');
  }

  // Role comes from the database, not the token, so demotions take effect immediately.
  req.user = await findAuthenticatedUser(verifyAccessToken(token));
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') {
    throw new ForbiddenError('Not authorized as admin', 'ADMIN_REQUIRED');
  }
  next();
}

/** For handlers mounted behind `authenticateRequest`. */
export function getAuthenticatedUser(req: Request): AuthenticatedUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}
