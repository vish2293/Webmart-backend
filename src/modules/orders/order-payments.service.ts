import { env } from '../../config/env.js';
import {
  createRazorpayOrder,
  fetchRazorpayOrderPayments,
  fetchRazorpayPayment,
  isValidPaymentSignature,
} from '../../integrations/razorpay.js';
import { BadRequestError, ConflictError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { AuthenticatedUser } from '../users/users.types.js';
import { applyMembershipRefundWebhook } from '../memberships/membership-refunds.service.js';
import { handleMembershipPaymentEvent } from '../memberships/memberships.service.js';
import { notCancelled, Order } from './order.model.js';
import {
  findPayableOrder,
  latePaymentRefundedCodes,
  paymentDeadline,
  recordOnlinePayment,
} from './order-payment-core.js';
import { toPaise } from './order-pricing.js';
import { applyRefundWebhook } from './order-refunds.service.js';
import { settleStripeCheckout } from './order-stripe.service.js';
import { cancelUnpaidOrder } from './order-lifecycle.service.js';
import type { RazorpayWebhookEvent, VerifyRazorpayPaymentInput } from './orders.validation.js';

const paidEvents = new Set(['payment.captured', 'order.paid']);

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

/**
 * Lets the customer give up on paying online and pay cash on delivery instead. One-way: a COD
 * order never expires, so turning an old COD order back into an online one would get it
 * cancelled at once. Refused while Razorpay holds a payment for the order.
 */
export async function switchToCashOnDelivery(orderId: string, payer: AuthenticatedUser) {
  const order = await findPayableOrder(orderId, payer);
  if (order.isPaid) throw new ConflictError('Order is already paid', 'ORDER_ALREADY_PAID');
  if (order.isCancelled) {
    throw new ConflictError(
      'This order was cancelled. Please place a new order.',
      'ORDER_CANCELLED',
    );
  }
  if (order.paymentMethod === 'Cash on Delivery') {
    throw new ConflictError('This order is already pay on delivery', 'ORDER_ALREADY_COD');
  }
  if (paymentDeadline(order.createdAt).getTime() < Date.now()) {
    throw new ConflictError(
      'The payment window for this order has closed. Please place a new order.',
      'ORDER_EXPIRED',
    );
  }
  if (order.razorpayOrderId) {
    const payments = await fetchRazorpayOrderPayments(order.razorpayOrderId);
    if (payments.some((payment) => ['captured', 'authorized'].includes(payment.status))) {
      throw new ConflictError(
        'A payment for this order is being processed. Please wait a moment and refresh.',
        'PAYMENT_IN_PROGRESS',
      );
    }
  }

  if (order.stripeCheckoutSessionId) {
    // Closes the Stripe page so it can't be paid after the switch; refuses if it already was.
    if ((await settleStripeCheckout(order.stripeCheckoutSessionId)) !== 'closed') {
      throw new ConflictError(
        'A payment for this order is being processed. Please wait a moment and refresh.',
        'PAYMENT_IN_PROGRESS',
      );
    }
  }

  // ponytail: a payment started in the gap between the check above and this update is still
  // recorded as paid by the webhook; the admin sees the order as paid and skips collecting cash.
  const switched = await Order.findOneAndUpdate(
    {
      _id: orderId,
      isPaid: false,
      paymentMethod: { $ne: 'Cash on Delivery' },
      refundedAt: { $exists: false },
      ...notCancelled,
    },
    { paymentMethod: 'Cash on Delivery' },
    { new: true },
  ).lean();
  if (!switched) {
    throw new ConflictError('The order changed. Please reload and try again.', 'ORDER_CHANGED');
  }
  return switched;
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
 * Called by the expiry sweep for an overdue unpaid order. Before cancelling, asks the gateway
 * (Stripe: closes the checkout page; Razorpay: lists payments) whether a payment exists, so a missed webhook doesn't cancel an order the customer paid for.
 */
export async function expireOrReconcileOrder(order: {
  _id: { toString(): string };
  razorpayOrderId?: string;
  stripeCheckoutSessionId?: string;
  totalPrice: number;
}): Promise<ExpiryOutcome> {
  const orderId = order._id.toString();

  if (order.stripeCheckoutSessionId) {
    // Closes the Stripe page first, so nothing can be paid once we cancel.
    const settlement = await settleStripeCheckout(order.stripeCheckoutSessionId);
    if (settlement === 'paid') return 'reconciled';
    if (settlement === 'pending') return 'skipped';
  }

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
