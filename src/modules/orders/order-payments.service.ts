import { env } from '../../config/env.js';
import {
  createRazorpayOrder,
  fetchRazorpayOrderPayments,
  isValidPaymentSignature,
} from '../../integrations/razorpay.js';
import { withTransaction } from '../../lib/db.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { AuthenticatedUser } from '../users/users.types.js';
import { notCancelled, Order } from './order.model.js';
import { toPaise } from './order-pricing.js';
import { cancelUnpaidOrder, reserveStock } from './orders.service.js';
import type { RazorpayWebhookEvent, VerifyRazorpayPaymentInput } from './orders.validation.js';

const paidEvents = new Set(['payment.captured', 'order.paid']);

type ReceivedPayment = { id: string; email?: string };

const paymentDeadline = (createdAt: Date) =>
  new Date(createdAt.getTime() + env.ORDER_PAYMENT_WINDOW_MINUTES * 60_000);

const paidUpdate = (payment: ReceivedPayment) => ({
  isPaid: true,
  paidAt: new Date(),
  paymentResult: {
    id: payment.id,
    status: 'captured',
    update_time: new Date().toISOString(),
    email_address: payment.email,
  },
});

async function findPayableOrder(orderId: string, payer: AuthenticatedUser) {
  const order = await Order.findById(orderId)
    .select('user isPaid isCancelled paymentMethod totalPrice razorpayOrderId createdAt')
    .lean();
  if (!order) throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
  if (order.user.toString() !== payer.id) {
    throw new ForbiddenError('You can only pay for your own orders', 'ORDER_FORBIDDEN');
  }
  return order;
}

/**
 * A payment landed after the order expired and its stock was released. Take the stock back if
 * it's still there; otherwise the customer must be refunded.
 */
async function reviveExpiredOrder(orderId: string, payment: ReceivedPayment) {
  try {
    return await withTransaction(async (session) => {
      const revived = await Order.findOneAndUpdate(
        { _id: orderId, isPaid: false, isCancelled: true },
        { ...paidUpdate(payment), isCancelled: false, $unset: { cancelledAt: 1 } },
        { new: true, session },
      ).lean();
      if (!revived) throw new ConflictError('Order changed concurrently', 'ORDER_CHANGED');
      await reserveStock(revived.orderItems, session);
      return revived;
    });
  } catch (error) {
    if (!(error instanceof ConflictError) || error.code !== 'INSUFFICIENT_STOCK') throw error;

    // ponytail: refunds are manual — search logs/admin for status "refund_required". Automate
    // with Razorpay's refund API if this happens often.
    await Order.updateOne(
      { _id: orderId, isPaid: false },
      { paymentResult: { ...paidUpdate(payment).paymentResult, status: 'refund_required' } },
    );
    logger.error(
      { orderId, paymentId: payment.id },
      'Payment received for an expired order whose stock is gone; refund required',
    );
    throw new ConflictError(
      'This order expired before your payment completed and the items are no longer available. Your payment will be refunded.',
      'ORDER_EXPIRED',
    );
  }
}

/**
 * Marks the order paid once. Safe to call from the browser verify call, the webhook and the
 * expiry sweep, in any order; later calls return the already-paid order.
 */
async function recordOnlinePayment(orderId: string, payment: ReceivedPayment) {
  const paid = await Order.findOneAndUpdate(
    { _id: orderId, isPaid: false, ...notCancelled },
    paidUpdate(payment),
    { new: true },
  ).lean();
  if (paid) return paid;

  const existing = await Order.findById(orderId).lean();
  if (!existing) throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
  if (!existing.isPaid && existing.isCancelled) return reviveExpiredOrder(orderId, payment);

  if (existing.paymentResult?.id !== payment.id) {
    // Two different payments for one order: the customer was charged twice.
    logger.error(
      { orderId, paymentId: payment.id, recordedPaymentId: existing.paymentResult?.id },
      'Duplicate payment received for an already-paid order; refund required',
    );
  }
  return existing;
}

export async function startRazorpayPayment(orderId: string, payer: AuthenticatedUser) {
  const order = await findPayableOrder(orderId, payer);
  if (order.isPaid) throw new ConflictError('Order is already paid', 'ORDER_ALREADY_PAID');
  if (order.isCancelled) {
    throw new ConflictError(
      'This order expired because it was not paid in time. Please place a new order.',
      'ORDER_CANCELLED',
    );
  }
  if (order.paymentMethod === 'Cash on Delivery') {
    throw new BadRequestError('This order is paid on delivery', 'PAYMENT_METHOD_OFFLINE');
  }

  const amountInPaise = toPaise(order.totalPrice);
  let razorpayOrderId = order.razorpayOrderId;

  // Reuse the gateway order across attempts; Razorpay allows retries on the same order.
  if (!razorpayOrderId) {
    const razorpayOrder = await createRazorpayOrder({
      amountInPaise,
      receipt: orderId,
      notes: { orderId },
    });
    const updated = await Order.findOneAndUpdate(
      { _id: orderId, razorpayOrderId: { $exists: false } },
      { razorpayOrderId: razorpayOrder.id },
      { new: true },
    )
      .select('razorpayOrderId')
      .lean();
    // A concurrent request may have attached its gateway order first; use that one.
    razorpayOrderId =
      updated?.razorpayOrderId ??
      (await Order.findById(orderId).select('razorpayOrderId').lean())?.razorpayOrderId;
  }

  return {
    keyId: env.RAZORPAY_KEY_ID,
    razorpayOrderId,
    amount: amountInPaise,
    currency: 'INR',
    /** The checkout window closes itself before this, so payments can't start after expiry. */
    expiresAt: paymentDeadline(order.createdAt).toISOString(),
  };
}

export async function verifyRazorpayPayment(
  orderId: string,
  payer: AuthenticatedUser,
  input: VerifyRazorpayPaymentInput,
) {
  const order = await findPayableOrder(orderId, payer);
  if (!order.razorpayOrderId || order.razorpayOrderId !== input.razorpay_order_id) {
    throw new BadRequestError('Payment does not belong to this order', 'PAYMENT_MISMATCH');
  }

  const isValid = isValidPaymentSignature({
    razorpayOrderId: input.razorpay_order_id,
    razorpayPaymentId: input.razorpay_payment_id,
    signature: input.razorpay_signature,
  });
  if (!isValid) {
    throw new BadRequestError('Payment verification failed', 'PAYMENT_SIGNATURE_INVALID');
  }

  return recordOnlinePayment(orderId, { id: input.razorpay_payment_id, email: payer.email });
}

/** Signature must already be verified. Unknown or irrelevant events are acknowledged and ignored. */
export async function handleRazorpayWebhookEvent(event: RazorpayWebhookEvent) {
  const payment = event.payload.payment?.entity;
  if (!paidEvents.has(event.event) || !payment?.order_id) return;

  const order = await Order.findOne({ razorpayOrderId: payment.order_id })
    .select('totalPrice')
    .lean();
  if (!order) {
    logger.warn({ razorpayOrderId: payment.order_id }, 'Webhook for unknown Razorpay order');
    return;
  }
  if (payment.amount !== toPaise(order.totalPrice)) {
    logger.error(
      { orderId: order._id, paid: payment.amount, expected: toPaise(order.totalPrice) },
      'Razorpay payment amount does not match order total',
    );
    return;
  }

  try {
    await recordOnlinePayment(order._id.toString(), {
      id: payment.id,
      email: payment.email ?? undefined,
    });
  } catch (error) {
    // Already logged for refund; retrying the webhook can't change the outcome.
    if (error instanceof ConflictError && error.code === 'ORDER_EXPIRED') return;
    throw error;
  }
}

export type ExpiryOutcome = 'cancelled' | 'reconciled' | 'skipped';

/**
 * Called by the expiry sweep for an overdue unpaid order. Before cancelling, asks Razorpay
 * whether a payment exists, so a missed webhook doesn't cancel an order the customer paid for.
 */
export async function expireOrReconcileOrder(order: {
  _id: { toString(): string };
  razorpayOrderId?: string;
  totalPrice: number;
}): Promise<ExpiryOutcome> {
  const orderId = order._id.toString();

  if (order.razorpayOrderId) {
    const payments = await fetchRazorpayOrderPayments(order.razorpayOrderId);
    const captured = payments.find(
      (payment) => payment.status === 'captured' && payment.amount === toPaise(order.totalPrice),
    );
    if (captured) {
      await recordOnlinePayment(orderId, { id: captured.id, email: captured.email ?? undefined });
      return 'reconciled';
    }
    // Authorized but not yet captured: Razorpay will capture or void it; check next sweep.
    if (payments.some((payment) => payment.status === 'authorized')) return 'skipped';
  }

  return (await cancelUnpaidOrder(orderId)) ? 'cancelled' : 'skipped';
}
