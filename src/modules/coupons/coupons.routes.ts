import { Router } from 'express';
import { authenticateRequest, requireAdmin } from '../../middleware/authenticate.js';
import * as couponsController from './coupons.controller.js';

export const couponsRouter = Router();

// Customers never call these: they enter a code at checkout and the order quote applies it.
couponsRouter.use(authenticateRequest, requireAdmin);

couponsRouter.route('/').get(couponsController.listCoupons).post(couponsController.createCoupon);
couponsRouter
  .route('/:id')
  .put(couponsController.updateCoupon)
  .delete(couponsController.deleteCoupon);
