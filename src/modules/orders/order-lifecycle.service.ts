import type { ClientSession } from 'mongoose';
import { withTransaction } from '../../lib/db.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import {
  creditEarnedPoints,
  releaseFirstOrderDiscount,
  returnSpentPoints,
  revokeEarnedPoints,
} from '../rewards/rewards.service.js';
import type { AuthenticatedUser } from '../users/users.types.js';
import {
  notCancelled,
  Order,
  type CancelReason,
  type OrderRecord,
  type RefundReason,
} from './order.model.js';
import { notifyOrder } from '../notifications/notifications.service.js';
import { pointsEarnedFor } from './order-pricing.js';
import {
  claimRefund,
  isGatewayPaymentId,
  recordManualRefund,
  submitClaimedRefund,
} from './order-refunds.service.js';
import { closeStripeCheckoutForOrder } from './order-stripe.service.js';
import { releaseStock } from './orders.service.js';
import { releaseCoupon } from '../coupons/coupons.service.js';
import type { MarkPaidInput } from './orders.validation.js';

type LifecycleAction = 'cancel' | 'ship' | 'deliver' | 'pay' | 'refund';

const notRefunded = { refundedAt: { $exists: false } } as const;
// Orders delivered before the shipped step existed have no `isShipped`; delivered implies shipped.
const notShipped = { isShipped: { $ne: true }, isDelivered: { $ne: true } } as const;
const hasShipped = { $or: [{ isShipped: true }, { isDelivered: true }] };
const isOrderShipped = (order: Pick<OrderRecord, 'isShipped' | 'isDelivered'>) =>
  order.isShipped === true || order.isDelivered === true;

/**
 * Every transition is a guarded update; when the guard misses, this turns the order's actual
 * state into the specific error the caller should see.
 */
function explainBlocked(order: OrderRecord | null, action: LifecycleAction): never {
  if (!order) throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
  if (order.isCancelled) throw new ConflictError('Order is cancelled', 'ORDER_CANCELLED');
  if (order.refundedAt) {
    throw action === 'refund'
      ? new ConflictError('Order is already refunded', 'ORDER_ALREADY_REFUNDED')
      : new ConflictError('Order has been refunded', 'ORDER_REFUNDED');
  }
  switch (action) {
    case 'cancel':
      if (isOrderShipped(order)) {
        throw new ConflictError(
          'This order has already shipped and can no longer be cancelled',
          'ORDER_ALREADY_SHIPPED',
        );
      }
      break;
    case 'ship':
      if (isOrderShipped(order)) {
        throw new ConflictError('Order is already shipped', 'ORDER_ALREADY_SHIPPED');
      }
      if (!order.isPaid) {
        throw new ConflictError('Online orders must be paid before shipping', 'ORDER_NOT_PAID');
      }
      break;
    case 'deliver':
      if (order.isDelivered) {
        throw new ConflictError('Order is already delivered', 'ORDER_ALREADY_DELIVERED');
      }
      if (!order.isShipped) throw new ConflictError('Ship the order first', 'ORDER_NOT_SHIPPED');
      break;
    case 'pay':
      if (order.isPaid) throw new ConflictError('Order is already paid', 'ORDER_ALREADY_PAID');
      break;
    case 'refund':
      if (!order.isPaid) throw new ConflictError('Order is not paid', 'ORDER_NOT_PAID');
      break;
  }
  throw new ConflictError('The order changed. Please reload and try again.', 'ORDER_CHANGED');
}

/**
 * Cancels inside the caller's transaction: returns stock, the points spent on the order and the
 * first-order discount. Returns null if the order shipped, was cancelled or refunded meanwhile.
 */
export async function cancelOrderInTransaction(
  order: Pick<OrderRecord, '_id' | 'user' | 'orderItems' | 'firstOrderDiscount' | 'coupon'>,
  reason: CancelReason,
  session: ClientSession,
  extraGuard: object = {},
) {
  const cancelled = await Order.findOneAndUpdate(
    { _id: order._id, ...notShipped, ...notCancelled, ...notRefunded, ...extraGuard },
    { isCancelled: true, cancelledAt: new Date(), cancelReason: reason },
    { new: true, session },
  ).lean();
  if (!cancelled) return null;

  const userId = order.user.toString();
  await releaseStock(cancelled.orderItems, session);
  await returnSpentPoints(userId, order._id.toString(), session);
  if (order.coupon) await releaseCoupon(order.coupon, userId, order._id.toString(), session);
  if (order.firstOrderDiscount > 0) await releaseFirstOrderDiscount(userId, session);
  return cancelled;
}

/** Payment-window expiry. Signature kept for the expiry sweep. */
export function cancelUnpaidOrder(orderId: string) {
  return withTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session).lean();
    if (!order) return null;
    return cancelOrderInTransaction(order, 'payment_expired', session, { isPaid: false });
  });
}

/**
 * Records, inside the caller's transaction, that a paid order's money must go back: a pending
 * Razorpay refund, or a manual one for cash. Returns the payment to submit after commit, if any.
 */
async function claimPaymentReturn(
  order: OrderRecord,
  reason: RefundReason,
  session: ClientSession,
) {
  if (!order.isPaid) return null;
  const orderId = order._id.toString();
  const paymentId = order.paymentResult?.id;
  // Cash collected on delivery (or an admin-confirmed payment with no gateway id) can't go
  // back through a gateway.
  if (order.paymentMethod === 'Cash on Delivery' || !isGatewayPaymentId(paymentId)) {
    await recordManualRefund(orderId, order.totalPrice, reason, session);
    return null;
  }
  return (await claimRefund({ orderId, paymentId, amount: order.totalPrice, reason }, session))
    ? paymentId
    : null;
}

async function reloadOrder(orderId: string) {
  const order = await Order.findById(orderId).lean();
  if (!order) throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
  return order;
}

/** Customer (own order) or admin, before shipping. Paid orders are refunded automatically. */
export async function cancelOrder(
  orderId: string,
  actor: AuthenticatedUser,
  refundReason?: RefundReason,
) {
  const isAdmin = actor.role === 'admin';
  const paymentToRefund = await withTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session).lean();
    if (!order) throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
    if (!isAdmin && order.user.toString() !== actor.id) {
      throw new ForbiddenError('You can only cancel your own orders', 'ORDER_FORBIDDEN');
    }
    const cancelled = await cancelOrderInTransaction(
      order,
      isAdmin ? 'admin' : 'customer',
      session,
    );
    if (!cancelled) return explainBlocked(order, 'cancel');
    const reason = refundReason ?? (isAdmin ? 'admin_cancel' : 'customer_cancel');
    return claimPaymentReturn(cancelled, reason, session);
  });

  // The gateway is called only after the cancel and the refund claim committed together.
  if (paymentToRefund) await submitClaimedRefund(orderId, paymentToRefund);
  await closeStripeCheckoutForOrder(orderId);
  await notifyOrder(orderId, 'cancelled');
  return reloadOrder(orderId);
}

/** Admin. Online orders must be paid first; cash-on-delivery orders ship unpaid. */
export async function shipOrder(orderId: string) {
  const shipped = await Order.findOneAndUpdate(
    {
      _id: orderId,
      ...notShipped,
      ...notCancelled,
      ...notRefunded,
      $or: [{ isPaid: true }, { paymentMethod: 'Cash on Delivery' }],
    },
    { isShipped: true, shippedAt: new Date() },
    { new: true },
  ).lean();
  if (!shipped) return explainBlocked(await Order.findById(orderId).lean(), 'ship');
  await notifyOrder(orderId, 'shipped');
  return shipped;
}

/** Credits points once an order is both paid and delivered, whichever happened last. */
async function awardPointsIfComplete(order: OrderRecord, session: ClientSession) {
  if (!order.isPaid || !order.isDelivered || order.isCancelled || order.refundedAt) return order;
  if (order.pointsEarnedAt) return order;

  const points = pointsEarnedFor(order.totalPrice, order.pointsMultiplier ?? 1);
  const awarded = await Order.findOneAndUpdate(
    { _id: order._id, pointsEarnedAt: { $exists: false } },
    { pointsEarned: points, pointsEarnedAt: new Date() },
    { new: true, session },
  ).lean();
  if (!awarded) return order;
  await creditEarnedPoints(order.user.toString(), order._id.toString(), points, session);
  return awarded;
}

export async function markOrderDelivered(orderId: string) {
  const result = await withTransaction(async (session) => {
    const delivered = await Order.findOneAndUpdate(
      {
        _id: orderId,
        isShipped: true,
        isDelivered: { $ne: true },
        ...notCancelled,
        ...notRefunded,
      },
      { isDelivered: true, deliveredAt: new Date() },
      { new: true, session },
    ).lean();
    if (!delivered) {
      return explainBlocked(await Order.findById(orderId).session(session).lean(), 'deliver');
    }
    return awardPointsIfComplete(delivered, session);
  });
  await notifyOrder(orderId, 'delivered');
  return result;
}

// ponytail: admin-only manual confirmation (e.g. cash collected). Online payments are recorded
// by Razorpay verification and webhooks.
export function markOrderPaid(orderId: string, payment: MarkPaidInput) {
  return withTransaction(async (session) => {
    const paid = await Order.findOneAndUpdate(
      { _id: orderId, isPaid: false, ...notCancelled, ...notRefunded },
      { isPaid: true, paidAt: new Date(), paymentResult: payment },
      { new: true, session },
    ).lean();
    if (!paid) return explainBlocked(await Order.findById(orderId).session(session).lean(), 'pay');
    return awardPointsIfComplete(paid, session);
  });
}

/**
 * Admin refund of a paid order. Before shipping it's a cancellation (restock, points and
 * discount back). After shipping the customer gets the cash and the points they spent back,
 * loses points earned on it, keeps the first-order discount used, and nothing is restocked.
 */
export async function refundOrder(orderId: string, admin: AuthenticatedUser) {
  const order = await reloadOrder(orderId);
  if (!isOrderShipped(order) && !order.isCancelled && !order.refundedAt && order.isPaid) {
    return cancelOrder(orderId, admin, 'admin_refund');
  }

  const paymentToRefund = await withTransaction(async (session) => {
    const updated = await Order.findOneAndUpdate(
      { _id: orderId, isPaid: true, ...hasShipped, ...notCancelled, ...notRefunded },
      { refundedAt: new Date() },
      { new: true, session },
    ).lean();
    if (!updated) {
      return explainBlocked(await Order.findById(orderId).session(session).lean(), 'refund');
    }
    const userId = updated.user.toString();
    await returnSpentPoints(userId, orderId, session);
    await revokeEarnedPoints(userId, orderId, session);
    return claimPaymentReturn(updated, 'admin_refund', session);
  });

  if (paymentToRefund) await submitClaimedRefund(orderId, paymentToRefund);
  await notifyOrder(orderId, 'refunded');
  return reloadOrder(orderId);
}
