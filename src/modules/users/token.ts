import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { UnauthorizedError } from '../../lib/errors.js';

const tokenPayloadSchema = z.object({ id: z.string(), iat: z.number() });

export type VerifiedToken = { userId: string; issuedAtSeconds: number };

export function signAccessToken(userId: string) {
  return jwt.sign({ id: userId }, env.JWT_SECRET, {
    algorithm: 'HS256',
    // Format is validated in config/env.ts.
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

/** Returns the user id and issue time from a valid token, or throws 401. */
export function verifyAccessToken(token: string): VerifiedToken {
  try {
    const payload = tokenPayloadSchema.parse(
      jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }),
    );
    return { userId: payload.id, issuedAtSeconds: payload.iat };
  } catch {
    throw new UnauthorizedError('Not authorized, token failed', 'AUTH_TOKEN_INVALID');
  }
}
