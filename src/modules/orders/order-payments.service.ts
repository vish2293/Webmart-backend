import { env } from '../../config/env.js';
import {
  createRazorpayOrder,
  fetchRazorpayOrderPayments,
  fetchRazorpayPayment,
  isValidPaymentSignature,
} from '../../integrations/razorpay.js';
import { withTransaction } from '../../lib/db.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { AuthenticatedUser } from '../users/users.types.js';
import { applyMembershipRefundWebhook } from '../memberships/membership-refunds.service.js';
import { handleMembershipPaymentEvent } from '../memberships/memberships.service.js';
import { claimFirstOrderDiscount, spendPoints } from '../rewards/rewards.service.js';
import { notCancelled, Order, type OrderRecord } from './order.model.js';
import { toPaise } from './order-pricing.js';
import { applyRefundWebhook, refundPayment } from './order-refunds.service.js';
import { cancelUnpaidOrder } from './order-lifecycle.service.js';
import { reserveStock } from './orders.service.js';
import type { RazorpayWebhookEvent, VerifyRazorpayPaymentInput } from './orders.validation.js';

const paidEvents = new Set(['payment.captured', 'order.paid']);

type ReceivedPayment = { id: string; email?: string; method?: string };

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
    method: payment.method,
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

/** Reasons a late payment can't bring an expired order back; the money is refunded instead. */
const revivalBlockers = new Set(['INSUFFICIENT_STOCK', 'PRICE_CHANGED', 'DISCOUNT_UNAVAILABLE']);

/** Codes for a late payment that was refunded; webhooks acknowledge these instead of retrying. */
const latePaymentRefundedCodes = new Set(['ORDER_EXPIRED', 'ORDER_CANCELLED_REFUNDED']);

/**
 * Re-takes everything the expiry gave back — stock, the points spent and the first-order
 * discount — in one transaction. Throws a ConflictError if any of it is gone.
 */
function reviveExpiredOrder(orderId: string, payment: ReceivedPayment) {
  return withTransaction(async (session) => {
    const revived = await Order.findOneAndUpdate(
      { _id: orderId, isPaid: false, isCancelled: true },
      {
        ...paidUpdate(payment),
        isCancelled: false,
        $unset: { cancelledAt: 1, cancelReason: 1 },
      },
      { new: true, session },
    ).lean();
    if (!revived) throw new ConflictError('Order changed concurrently', 'ORDER_CHANGED');

    const userId = revived.user.toString();
    await reserveStock(revived.orderItems, session);
    await spendPoints(userId, orderId, revived.pointsRedeemed ?? 0, session, 'revive_redeem');
    if (
      (revived.firstOrderDiscount ?? 0) > 0 &&
      !(await claimFirstOrderDiscount(userId, session))
    ) {
      throw new ConflictError('First-order discount already used', 'DISCOUNT_UNAVAILABLE');
    }
    return revived;
  });
}

/**
 * A payment landed on a cancelled, unpaid order. Orders that merely expired come back if
 * everything they held can be re-taken; anything else (customer or admin cancelled, stock,
 * points or discount gone) is refunded in full.
 */
async function handleLatePayment(
  order: OrderRecord,
  payment: ReceivedPayment,
): Promise<OrderRecord> {
  const orderId = order._id.toString();
  // Orders cancelled before cancel reasons existed could only have expired.
  const hasExpired = (order.cancelReason ?? 'payment_expired') === 'payment_expired';

  if (hasExpired) {
    try {
      return await reviveExpiredOrder(orderId, payment);
    } catch (error) {
      if (error instanceof ConflictError && error.code === 'ORDER_CHANGED') {
        // A concurrent call for this payment got there first; report its outcome.
        return recordOnlinePayment(orderId, payment);
      }
      if (!(error instanceof ConflictError) || !revivalBlockers.has(error.code)) throw error;
    }
  }

  logger.warn({ orderId, paymentId: payment.id }, 'Late payment on a cancelled order; refunding');
  await refundPayment({
    orderId,
    paymentId: payment.id,
    amount: order.totalPrice,
    reason: 'late_payment',
  });
  throw hasExpired
    ? new ConflictError(
        'This order expired before your payment completed and the items are no longer available. Your payment will be refunded.',
        'ORDER_EXPIRED',
      )
    : new ConflictError(
        'This order was cancelled before your payment completed. Your payment will be refunded.',
        'ORDER_CANCELLED_REFUNDED',
      );
}

/**
 * Marks the order paid once. Safe to call from the browser verify call, the webhook and the
 * expiry sweep, in any order; later calls return the already-paid order.
 */
async function recordOnlinePayment(
  orderId: string,
  payment: ReceivedPayment,
): Promise<OrderRecord> {
  const paid = await Order.findOneAndUpdate(
    { _id: orderId, isPaid: false, ...notCancelled },
    paidUpdate(payment),
    { new: true },
  ).lean();
  if (paid) return paid;

  const existing = await Order.findById(orderId).lean();
  if (!existing) throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
  if (!existing.isPaid && existing.isCancelled) return handleLatePayment(existing, payment);

  if (existing.paymentResult?.id !== payment.id) {
    // Two different payments for one order: the customer was charged twice. Give one back.
    logger.warn(
      { orderId, paymentId: payment.id, recordedPaymentId: existing.paymentResult?.id },
      'Duplicate payment received for an already-paid order; refunding it',
    );
    await refundPayment({
      orderId,
      paymentId: payment.id,
      amount: existing.totalPrice,
      reason: 'duplicate_payment',
    });
    return (await Order.findById(orderId).lean()) ?? existing;
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

  // The signature proves the payment belongs to this order; Razorpay itself confirms the money
  // was actually captured, and for the full amount.
  const payment = await fetchRazorpayPayment(input.razorpay_payment_id);
  if (payment.amount !== toPaise(order.totalPrice)) {
    throw new BadRequestError('Payment amount does not match this order', 'PAYMENT_NOT_CAPTURED');
  }
  if (payment.status === 'authorized') {
    // The payment.captured webhook completes it.
    throw new ConflictError(
      'Payment received. We are confirming it with the bank; this page will update shortly.',
      'PAYMENT_PENDING',
    );
  }
  if (payment.status !== 'captured') {
    throw new BadRequestError('Payment was not completed', 'PAYMENT_NOT_CAPTURED');
  }

  return recordOnlinePayment(orderId, {
    id: payment.id,
    email: payer.email,
    method: payment.method,
  });
}

/** Signature must already be verified. Unknown or irrelevant events are acknowledged and ignored. */
export async function handleRazorpayWebhookEvent(event: RazorpayWebhookEvent) {
  const refund = event.payload.refund?.entity;
  if (refund && (event.event === 'refund.processed' || event.event === 'refund.failed')) {
    if (await applyMembershipRefundWebhook(refund, event.event)) return;
    await applyRefundWebhook(refund, event.event);
    return;
  }

  const payment = event.payload.payment?.entity;
  if (!paidEvents.has(event.event) || !payment?.order_id) return;
  if (await handleMembershipPaymentEvent({ ...payment, order_id: payment.order_id })) return;

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
      method: payment.method ?? undefined,
    });
  } catch (error) {
    // Already logged for refund; retrying the webhook can't change the outcome.
    if (error instanceof ConflictError && latePaymentRefundedCodes.has(error.code)) return;
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
