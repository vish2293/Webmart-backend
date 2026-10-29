import { Router } from 'express';
import { authenticateRequest, requireAdmin } from '../../middleware/authenticate.js';
import { perUserRateLimit } from '../../middleware/rate-limit.js';
import * as controller from './memberships.controller.js';

// Each checkout may call the payment gateway.
const paymentRateLimit = perUserRateLimit(20);
const cancelRateLimit = perUserRateLimit(10);

export const membershipsRouter = Router();

membershipsRouter.get('/plans', controller.listPlans);

membershipsRouter.use(authenticateRequest);

membershipsRouter.get('/me', controller.getMyMembership);
membershipsRouter.post('/checkout', paymentRateLimit, controller.startCheckout);
membershipsRouter.post('/:id/verify', paymentRateLimit, controller.verifyPayment);
membershipsRouter.post('/:id/cancel', cancelRateLimit, controller.cancelMembership);

membershipsRouter.get('/', requireAdmin, controller.listMemberships);
membershipsRouter.post('/:id/refund', requireAdmin, controller.adminRefund);
membershipsRouter.post('/:id/refund/retry', requireAdmin, controller.retryRefund);
