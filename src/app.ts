import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFound } from './middleware/error-handler.js';
import { apiRateLimit } from './middleware/rate-limit.js';
import { apiRouter, healthRouter, stripeRouter, webhooksRouter } from './routes/index.js';

const requestIdPattern = /^[\w-]{1,64}$/;

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id =
          typeof incoming === 'string' && requestIdPattern.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (_req, res, error) =>
        error || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS }));
  app.use('/api/webhooks', webhooksRouter);
  app.use('/api/stripe', stripeRouter);
  app.use(express.json({ limit: '100kb' }));

  app.use('/health', healthRouter);
  // Webhooks are mounted above and stay unlimited: gateway retries can burst.
  app.use('/api', apiRateLimit, apiRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
