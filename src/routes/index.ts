import express, { Router } from 'express';
import { isDatabaseReady } from '../lib/db.js';
import { requireCronSecret } from '../middleware/cron-auth.js';
import { membershipsRouter } from '../modules/memberships/memberships.routes.js';
import { runExpirySweeps } from '../modules/orders/order-expiry.job.js';
import { handleRazorpayWebhook } from '../modules/orders/orders.controller.js';
import { ordersRouter } from '../modules/orders/orders.routes.js';
import { reviewsRouter } from '../modules/reviews/reviews.routes.js';
import { productsRouter } from '../modules/products/products.routes.js';
import { rewardsRouter } from '../modules/rewards/rewards.routes.js';
import { wishlistRouter } from '../modules/wishlist/wishlist.routes.js';
import { usersRouter } from '../modules/users/users.routes.js';

export const apiRouter = Router();

apiRouter.use('/products/:productId/reviews', reviewsRouter);
apiRouter.use('/products', productsRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/orders', ordersRouter);
apiRouter.use('/rewards', rewardsRouter);
apiRouter.use('/wishlist', wishlistRouter);
apiRouter.use('/memberships', membershipsRouter);

/** Serverless hosts (Vercel) can't run the expiry timer from server.ts; an external scheduler can call this. */
const cronRouter = Router();
cronRouter.get('/expire-orders', requireCronSecret, async (_req, res) => {
  res.json(await runExpirySweeps());
});
apiRouter.use('/cron', cronRouter);

/** Must be mounted before `express.json()`: signature checks need the raw body. */
export const webhooksRouter = Router();

webhooksRouter.post(
  '/razorpay',
  express.raw({ type: 'application/json', limit: '1mb' }),
  handleRazorpayWebhook,
);

export const healthRouter = Router();

healthRouter.get('/live', (_req, res) => {
  res.json({ status: 'ok' });
});

healthRouter.get('/ready', (_req, res) => {
  const isReady = isDatabaseReady();
  res.status(isReady ? 200 : 503).json({ status: isReady ? 'ok' : 'unavailable' });
});
