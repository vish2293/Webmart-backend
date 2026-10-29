import type { Request, Response } from 'express';
import { idParamsSchema } from '../../lib/validation.js';
import { getAuthenticatedUser } from '../../middleware/authenticate.js';
import { verifyRazorpayPaymentSchema } from '../orders/orders.validation.js';
import * as refunds from './membership-refunds.service.js';
import { checkoutMembershipSchema } from './memberships.validation.js';
import * as membershipsService from './memberships.service.js';

export function listPlans(_req: Request, res: Response) {
  res.json(membershipsService.listPlans());
}

export async function getMyMembership(req: Request, res: Response) {
  res.json(await membershipsService.getMembershipSummary(getAuthenticatedUser(req).id));
}

export async function startCheckout(req: Request, res: Response) {
  const { plan } = checkoutMembershipSchema.parse(req.body);
  const checkout = await membershipsService.startMembershipCheckout(
    getAuthenticatedUser(req).id,
    plan,
  );
  res.status(201).json(checkout);
}

export async function verifyPayment(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  const input = verifyRazorpayPaymentSchema.parse(req.body);
  res.json(
    await membershipsService.verifyMembershipPayment(getAuthenticatedUser(req).id, id, input),
  );
}

export async function cancelMembership(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  const user = getAuthenticatedUser(req);
  await refunds.refundMembership(id, { kind: 'customer', userId: user.id });
  res.json(await membershipsService.getMembershipSummary(user.id));
}

export async function listMemberships(_req: Request, res: Response) {
  res.json(await membershipsService.listMemberships());
}

export async function adminRefund(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  res.json(await refunds.refundMembership(id, { kind: 'admin' }));
}

export async function retryRefund(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  res.json(await refunds.retryMembershipRefund(id));
}
