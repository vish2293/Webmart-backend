import { env } from '../../config/env.js';
import { refundPayment } from './order-refunds.service.js';
import { withTransaction } from '../../lib/db.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { notifyOrder } from '../notifications/notifications.service.js';
import { claimCoupon } from '../coupons/coupons.service.js';
import { claimFirstOrderDiscount, spendPoints } from '../rewards/rewards.service.js';
import type { AuthenticatedUser } from '../users/users.types.js';
import { notCancelled, Order, type OrderRecord } from './order.model.js';
import { reserveStock } from './orders.service.js';

// Shared by every payment gateway: how a confirmed payment becomes a paid order.

export type ReceivedPayment = { id: string; email?: string; method?: string };

export const paymentDeadline = (createdAt: Date) =>
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

export async function findPayableOrder(orderId: string, payer: AuthenticatedUser) {
  const order = await Order.findById(orderId)
    .select(
      'user isPaid isCancelled paymentMethod totalPrice razorpayOrderId stripeCheckoutSessionId createdAt',
    )
    .lean();
  if (!order) throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
  if (order.user.toString() !== payer.id) {
    throw new ForbiddenError('You can only pay for your own orders', 'ORDER_FORBIDDEN');
  }
  return order;
}

/** Reasons a late payment can't bring an expired order back; the money is refunded instead. */
const revivalBlockers = new Set([
  'INSUFFICIENT_STOCK',
  'PRICE_CHANGED',
  'DISCOUNT_UNAVAILABLE',
  'COUPON_UNAVAILABLE',
]);

/** Codes for a late payment that was refunded; webhooks acknowledge these instead of retrying. */
export const latePaymentRefundedCodes = new Set(['ORDER_EXPIRED', 'ORDER_CANCELLED_REFUNDED']);

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
    if (revived.coupon) await claimCoupon(revived.coupon, userId, orderId, session);
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
      const revived = await reviveExpiredOrder(orderId, payment);
      await notifyOrder(orderId, 'confirmed');
      return revived;
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
export async function recordOnlinePayment(
  orderId: string,
  payment: ReceivedPayment,
): Promise<OrderRecord> {
  const paid = await Order.findOneAndUpdate(
    { _id: orderId, isPaid: false, ...notCancelled },
    paidUpdate(payment),
    { new: true },
  ).lean();
  if (paid) {
    await notifyOrder(orderId, 'confirmed');
    return paid;
  }

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
