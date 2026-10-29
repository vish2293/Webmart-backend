import { Router } from 'express';
import { authenticateRequest, requireAdmin } from '../../middleware/authenticate.js';
import { perUserRateLimit } from '../../middleware/rate-limit.js';
import * as ordersController from './orders.controller.js';

const placeOrderRateLimit = perUserRateLimit(10);
// Each start may call the payment gateway.
const paymentRateLimit = perUserRateLimit(20);
// Checkout re-quotes whenever the cart or points choice changes.
const quoteRateLimit = perUserRateLimit(60);
const cancelRateLimit = perUserRateLimit(10);

export const ordersRouter = Router();

ordersRouter.use(authenticateRequest);

ordersRouter
  .route('/')
  .post(placeOrderRateLimit, ordersController.createOrder)
  .get(requireAdmin, ordersController.listAllOrders);

ordersRouter.post('/quote', quoteRateLimit, ordersController.quoteOrder);
ordersRouter.get('/myorders', ordersController.listMyOrders);
ordersRouter.get('/:id', ordersController.getOrder);
ordersRouter.post('/:id/razorpay', paymentRateLimit, ordersController.startRazorpayPayment);
ordersRouter.post('/:id/razorpay/verify', paymentRateLimit, ordersController.verifyRazorpayPayment);
// Owner or admin; the service checks ownership.
ordersRouter.post('/:id/cancel', cancelRateLimit, ordersController.cancelOrder);
ordersRouter.put('/:id/pay', requireAdmin, ordersController.markOrderPaid);
ordersRouter.put('/:id/ship', requireAdmin, ordersController.shipOrder);
ordersRouter.put('/:id/deliver', requireAdmin, ordersController.markOrderDelivered);
ordersRouter.post('/:id/refund', requireAdmin, ordersController.refundOrder);
ordersRouter.post('/:id/refunds/:paymentId/retry', requireAdmin, ordersController.retryRefund);
