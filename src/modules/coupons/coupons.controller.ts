import type { Request, Response } from 'express';
import { idParamsSchema } from '../../lib/validation.js';
import * as couponsService from './coupons.service.js';
import { createCouponSchema, updateCouponSchema } from './coupons.validation.js';

export async function listCoupons(_req: Request, res: Response) {
  res.json(await couponsService.listCoupons());
}

export async function createCoupon(req: Request, res: Response) {
  res.status(201).json(await couponsService.createCoupon(createCouponSchema.parse(req.body)));
}

export async function updateCoupon(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  res.json(await couponsService.updateCoupon(id, updateCouponSchema.parse(req.body)));
}

export async function deleteCoupon(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  await couponsService.deleteCoupon(id);
  res.json({ message: 'Coupon deleted' });
}
