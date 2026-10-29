import type { AuthenticatedUser } from '../modules/users/users.types.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by `authenticateRequest`; always present on protected routes. */
      user?: AuthenticatedUser;
    }
  }
}

export {};
