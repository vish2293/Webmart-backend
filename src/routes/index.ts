import express, { Router } from 'express';
import { isDatabaseReady } from '../lib/db.js';
import { handleRazorpayWebhook } from '../modules/orders/orders.controller.js';
import { ordersRouter } from '../modules/orders/orders.routes.js';
import { productsRouter } from '../modules/products/products.routes.js';
import { usersRouter } from '../modules/users/users.routes.js';

export const apiRouter = Router();

apiRouter.use('/products', productsRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/orders', ordersRouter);

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
