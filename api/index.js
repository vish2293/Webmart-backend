// Vercel serverless entry. Runs the compiled app from dist/ (built by `npm run build`); the
// long-running server.ts (listen, expiry timer, graceful shutdown) is not used here.
import { createApp } from '../dist/app.js';
import { connectDatabase } from '../dist/lib/db.js';
import { logger } from '../dist/lib/logger.js';

const app = createApp();
let connecting;

/** One connection per warm instance; a failed attempt is retried by the next request. */
function ensureDatabase() {
  connecting ??= connectDatabase().catch((error) => {
    connecting = undefined;
    throw error;
  });
  return connecting;
}

export default async function handler(req, res) {
  try {
    await ensureDatabase();
  } catch (error) {
    logger.error({ err: error }, 'Database connection failed');
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: 'Service unavailable', code: 'DATABASE_UNAVAILABLE' }));
    return;
  }
  return app(req, res);
}
