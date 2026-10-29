import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { expireOrReconcileOrder, type ExpiryOutcome } from './order-payments.service.js';
import { notCancelled, Order } from './order.model.js';

const sweepIntervalMs = 60_000;
const batchSize = 50;

/**
 * Cancels online orders left unpaid past the payment window and returns their stock.
 * Cash-on-delivery orders are paid at the door, so they never expire.
 *
 * Safe on multiple replicas: each cancellation is a guarded transaction, so two instances
 * sweeping the same order cancel it once.
 */
export async function expireUnpaidOrders(now = new Date()) {
  const cutoff = new Date(now.getTime() - env.ORDER_PAYMENT_WINDOW_MINUTES * 60_000);
  const overdue = await Order.find({
    isPaid: false,
    ...notCancelled,
    paymentMethod: { $ne: 'Cash on Delivery' },
    createdAt: { $lt: cutoff },
  })
    .select('razorpayOrderId totalPrice')
    .sort({ createdAt: 1 })
    .limit(batchSize)
    .lean();

  const counts: Record<ExpiryOutcome | 'failed', number> = {
    cancelled: 0,
    reconciled: 0,
    skipped: 0,
    failed: 0,
  };
  // Sequential on purpose: bounded load on the database and the payment gateway.
  for (const order of overdue) {
    try {
      counts[await expireOrReconcileOrder(order)] += 1;
    } catch (error) {
      counts.failed += 1;
      logger.error({ err: error, orderId: order._id }, 'Failed to expire order; will retry');
    }
  }
  if (overdue.length > 0) logger.info(counts, 'Order expiry sweep finished');
  return counts;
}

/** Starts the periodic sweep. Returns a function that stops it and waits for a running sweep. */
export function startOrderExpiryJob() {
  let running: Promise<unknown> | null = null;

  const timer = setInterval(() => {
    if (running) return; // Previous sweep still going; skip this tick.
    running = expireUnpaidOrders()
      .catch((error: unknown) => logger.error({ err: error }, 'Order expiry sweep failed'))
      .finally(() => {
        running = null;
      });
  }, sweepIntervalMs);

  return async function stop() {
    clearInterval(timer);
    await running;
  };
}
