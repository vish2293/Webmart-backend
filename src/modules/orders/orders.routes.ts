import { Router } from 'express';
import { authenticateRequest, requireAdmin } from '../../middleware/authenticate.js';
import { perUserRateLimit } from '../../middleware/rate-limit.js';
import * as ordersController from './orders.controller.js';

const placeOrderRateLimit = perUserRateLimit(10);
// Each start may call the payment gateway.
const paymentRateLimit = perUserRateLimit(20);

export const ordersRouter = Router();

ordersRouter.use(authenticateRequest);

ordersRouter
  .route('/')
  .post(placeOrderRateLimit, ordersController.createOrder)
  .get(requireAdmin, ordersController.listAllOrders);

ordersRouter.get('/myorders', ordersController.listMyOrders);
ordersRouter.get('/:id', ordersController.getOrder);
ordersRouter.post('/:id/razorpay', paymentRateLimit, ordersController.startRazorpayPayment);
ordersRouter.post('/:id/razorpay/verify', paymentRateLimit, ordersController.verifyRazorpayPayment);
ordersRouter.put('/:id/pay', requireAdmin, ordersController.markOrderPaid);
ordersRouter.put('/:id/deliver', requireAdmin, ordersController.markOrderDelivered);
