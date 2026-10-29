import { env } from './config/env.js';
import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './lib/db.js';
import { logger } from './lib/logger.js';
import { startOrderExpiryJob } from './modules/orders/order-expiry.job.js';

const shutdownTimeoutMs = 10_000;

async function start() {
  await connectDatabase();

  const server = createApp().listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Server listening');
  });
  // ponytail: runs in the API process; every replica sweeps, which is safe (guarded updates)
  // but redundant. Move to a single worker if replicas grow.
  const stopOrderExpiryJob = startOrderExpiryJob();

  let isShuttingDown = false;
  async function shutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const forceExit = setTimeout(() => {
      logger.error('Shutdown timed out, forcing exit');
      process.exit(1);
    }, shutdownTimeoutMs);
    forceExit.unref();

    server.close(async (error) => {
      if (error) logger.error({ err: error }, 'Error closing HTTP server');
      await stopOrderExpiryJob();
      await disconnectDatabase();
      process.exit(error ? 1 : 0);
    });
    server.closeIdleConnections();
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  process.exit(1);
});

start().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Failed to start server');
  process.exit(1);
});
