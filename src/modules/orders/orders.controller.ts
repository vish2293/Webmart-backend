import type { Request, Response } from 'express';
import { idParamsSchema } from '../../lib/validation.js';
import { getAuthenticatedUser } from '../../middleware/authenticate.js';
import { isValidWebhookSignature } from '../../integrations/razorpay.js';
import { AppError, BadRequestError } from '../../lib/errors.js';
import { constructWebhookEvent, isStripeConfigured } from '../../integrations/stripe.js';
import * as orderLifecycle from './order-lifecycle.service.js';
import * as orderPaymentsService from './order-payments.service.js';
import * as orderRefunds from './order-refunds.service.js';
import * as orderStripe from './order-stripe.service.js';
import { StripeEvent } from './stripe-event.model.js';
import * as ordersService from './orders.service.js';
import {
  createOrderSchema,
  idempotencyKeySchema,
  markPaidSchema,
  quoteOrderSchema,
  razorpayWebhookEventSchema,
  refundParamsSchema,
  verifyRazorpayPaymentSchema,
} from './orders.validation.js';

export async function quoteOrder(req: Request, res: Response) {
  const input = quoteOrderSchema.parse(req.body);
  res.json(await ordersService.quoteOrder(getAuthenticatedUser(req).id, input));
}

export async function startRazorpayPayment(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  const checkout = await orderPaymentsService.startRazorpayPayment(id, getAuthenticatedUser(req));
  res.status(201).json(checkout);
}

/** Which online payment methods this server can take, so checkout only offers working ones. */
export function getPaymentOptions(_req: Request, res: Response) {
  res.json({ stripe: isStripeConfigured });
}

export async function startStripePayment(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  res.status(201).json(await orderStripe.startStripePayment(id, getAuthenticatedUser(req)));
}

export async function syncStripePayment(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  res.json(await orderStripe.syncStripePayment(id, getAuthenticatedUser(req)));
}

/**
 * POST /api/stripe/webhook. Mounted with `express.raw`, so `req.body` is the exact bytes Stripe
 * signed. Anything that fails the signature check is rejected before it is parsed or trusted.
 */
export async function handleStripeWebhook(req: Request, res: Response) {
  const signature = req.header('stripe-signature');
  if (!Buffer.isBuffer(req.body) || !signature) {
    throw new BadRequestError('Invalid webhook signature', 'WEBHOOK_SIGNATURE_INVALID');
  }
  let event;
  try {
    event = constructWebhookEvent(req.body, signature);
  } catch (error) {
    if (error instanceof AppError) throw error; // webhooks not configured: 503
    throw new BadRequestError('Invalid webhook signature', 'WEBHOOK_SIGNATURE_INVALID');
  }

  // Stripe redelivers events (retries, replays). One that already finished is just acknowledged.
  if (await StripeEvent.exists({ _id: event.id })) {
    res.json({ received: true, duplicate: true });
    return;
  }
  // Non-2xx makes Stripe retry, which is what we want if the database is briefly down. The
  // handlers are idempotent, so two deliveries racing here can't double-apply anything.
  await orderStripe.handleStripeEvent(event);
  await StripeEvent.updateOne(
    { _id: event.id },
    { $setOnInsert: { type: event.type, processedAt: new Date() } },
    { upsert: true },
  );
  res.json({ received: true });
}

export async function switchToCashOnDelivery(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  res.json(await orderPaymentsService.switchToCashOnDelivery(id, getAuthenticatedUser(req)));
}

export async function verifyRazorpayPayment(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  const input = verifyRazorpayPaymentSchema.parse(req.body);
  res.json(await orderPaymentsService.verifyRazorpayPayment(id, getAuthenticatedUser(req), input));
}

/** Mounted with `express.raw`, so `req.body` is the exact bytes Razorpay signed. */
export async function handleRazorpayWebhook(req: Request, res: Response) {
  const signature = req.header('x-razorpay-signature');
  if (!Buffer.isBuffer(req.body) || !signature || !isValidWebhookSignature(req.body, signature)) {
    throw new BadRequestError('Invalid webhook signature', 'WEBHOOK_SIGNATURE_INVALID');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    throw new BadRequestError('Malformed webhook body', 'INVALID_BODY');
  }

  // Non-2xx makes Razorpay retry, which is what we want if the database is briefly down.
  await orderPaymentsService.handleRazorpayWebhookEvent(razorpayWebhookEventSchema.parse(payload));
  res.json({ status: 'ok' });
}

export async function createOrder(req: Request, res: Response) {
  const input = createOrderSchema.parse(req.body);
  const idempotencyKey = idempotencyKeySchema.parse(req.header('idempotency-key'));
  const { order, isNew } = await ordersService.createOrder(
    getAuthenticatedUser(req).id,
    input,
    idempotencyKey,
  );
  // 200 for a replayed request, so clients can tell it wasn't a second order.
  res.status(isNew ? 201 : 200).json(order);
}

export async function getOrder(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  res.json(await ordersService.getOrderForUser(id, getAuthenticatedUser(req)));
}

export async function listMyOrders(req: Request, res: Response) {
  res.json(await ordersService.listOrdersForUser(getAuthenticatedUser(req).id));
}

export async function listAllOrders(_req: Request, res: Response) {
  res.json(await ordersService.listAllOrders());
}

export async function markOrderPaid(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  res.json(await orderLifecycle.markOrderPaid(id, markPaidSchema.parse(req.body)));
}

export async function markOrderDelivered(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  res.json(await orderLifecycle.markOrderDelivered(id));
}

export async function shipOrder(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  res.json(await orderLifecycle.shipOrder(id));
}

export async function cancelOrder(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  res.json(await orderLifecycle.cancelOrder(id, getAuthenticatedUser(req)));
}

export async function refundOrder(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  res.json(await orderLifecycle.refundOrder(id, getAuthenticatedUser(req)));
}

export async function retryRefund(req: Request, res: Response) {
  const { id, paymentId } = refundParamsSchema.parse(req.params);
  res.json(await orderRefunds.retryFailedRefund(id, paymentId));
}
