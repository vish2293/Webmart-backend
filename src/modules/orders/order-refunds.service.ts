import type { ClientSession } from 'mongoose';
import { createRazorpayRefund, listRazorpayPaymentRefunds } from '../../integrations/razorpay.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { Order, type RefundReason, type RefundRecord, type RefundStatus } from './order.model.js';
import { toPaise } from './order-pricing.js';

/** Marker payment id for cash-on-delivery money that must be returned outside the app. */
export const codPaymentId = 'cod';

const toRefundStatus = (razorpayStatus: string): RefundStatus =>
  razorpayStatus === 'processed' ? 'processed' : razorpayStatus === 'failed' ? 'failed' : 'pending';

async function findRefund(orderId: string, paymentId: string): Promise<RefundRecord> {
  const order = await Order.findById(orderId).select('refunds').lean();
  const refund = order?.refunds?.find((entry) => entry.paymentId === paymentId);
  if (!refund) throw new NotFoundError('Refund not found', 'REFUND_NOT_FOUND');
  return refund;
}

/** Updates the refund entry for `paymentId` via the positional operator. */
async function updateRefund(
  orderId: string,
  paymentId: string,
  set: Partial<RefundRecord>,
  unset: (keyof RefundRecord)[] = [],
) {
  const prefix = (field: string) => `refunds.$.${field}`;
  await Order.updateOne(
    { _id: orderId, 'refunds.paymentId': paymentId },
    {
      $set: Object.fromEntries(Object.entries(set).map(([key, value]) => [prefix(key), value])),
      ...(unset.length > 0 && { $unset: Object.fromEntries(unset.map((key) => [prefix(key), 1])) }),
    },
  );
}

/**
 * Sends a refund this caller has claimed (entry already 'pending') to Razorpay. Never throws for
 * gateway errors: the entry becomes 'failed' and an admin can retry it.
 */
async function submitRefund(
  orderId: string,
  paymentId: string,
  amount: number,
  reason: RefundReason,
): Promise<RefundRecord> {
  try {
    // If an earlier attempt reached Razorpay but we crashed before saving, reuse that refund
    // instead of refunding the customer twice.
    const existing = (await listRazorpayPaymentRefunds(paymentId)).find(
      (refund) => refund.status !== 'failed',
    );
    const refund =
      existing ??
      (await createRazorpayRefund({
        paymentId,
        amountInPaise: toPaise(amount),
        notes: { orderId, reason },
      }));
    const status = toRefundStatus(refund.status);
    await updateRefund(
      orderId,
      paymentId,
      {
        razorpayRefundId: refund.id,
        status,
        ...(status === 'processed' && { processedAt: new Date() }),
      },
      ['failureReason'],
    );
  } catch (error) {
    logger.error({ err: error, orderId, paymentId }, 'Razorpay refund failed; an admin can retry');
    await updateRefund(orderId, paymentId, {
      status: 'failed',
      failureReason: error instanceof Error ? error.message : 'Refund failed',
    });
  }
  return findRefund(orderId, paymentId);
}

/**
 * Refunds one payment in full. Idempotent per payment: the first caller claims it by adding a
 * 'pending' entry; anyone else (double click, concurrent cancel) gets that same entry back.
 */
export async function refundPayment(params: {
  orderId: string;
  paymentId: string;
  amount: number;
  reason: RefundReason;
}): Promise<RefundRecord> {
  const { orderId, paymentId, amount, reason } = params;
  const claimed = await Order.updateOne(
    { _id: orderId, 'refunds.paymentId': { $ne: paymentId } },
    {
      $push: {
        refunds: { paymentId, amount, status: 'pending', reason, requestedAt: new Date() },
      },
    },
  );
  if (claimed.modifiedCount === 0) return findRefund(orderId, paymentId);
  return submitRefund(orderId, paymentId, amount, reason);
}

export async function retryFailedRefund(orderId: string, paymentId: string) {
  const claimed = await Order.findOneAndUpdate(
    { _id: orderId, refunds: { $elemMatch: { paymentId, status: 'failed' } } },
    { $set: { 'refunds.$.status': 'pending' } },
    { new: true },
  ).lean();
  const entry = claimed?.refunds.find((refund) => refund.paymentId === paymentId);
  if (!entry) {
    throw new ConflictError('Only failed refunds can be retried', 'REFUND_NOT_RETRYABLE');
  }
  return submitRefund(orderId, paymentId, entry.amount, entry.reason);
}

/** Cash-on-delivery payments can't go back through Razorpay; flag them for the admin. */
export async function recordManualRefund(
  orderId: string,
  amount: number,
  reason: RefundReason,
  session?: ClientSession,
) {
  await Order.updateOne(
    { _id: orderId, 'refunds.paymentId': { $ne: codPaymentId } },
    {
      $push: {
        refunds: {
          paymentId: codPaymentId,
          amount,
          status: 'manual_required',
          reason,
          requestedAt: new Date(),
        },
      },
    },
    { session },
  );
}

/**
 * Razorpay refund events. Matched by refund id, or — when the webhook beats our own save of
 * that id — by the payment's pending refund.
 */
export async function applyRefundWebhook(
  entity: { id: string; payment_id: string },
  event: 'refund.processed' | 'refund.failed',
) {
  const isProcessed = event === 'refund.processed';
  const update = {
    'refunds.$.status': isProcessed ? 'processed' : 'failed',
    'refunds.$.razorpayRefundId': entity.id,
    ...(isProcessed
      ? { 'refunds.$.processedAt': new Date() }
      : { 'refunds.$.failureReason': 'Refund failed at the bank' }),
  };

  let result = await Order.updateOne({ 'refunds.razorpayRefundId': entity.id }, { $set: update });
  if (result.matchedCount === 0) {
    result = await Order.updateOne(
      { refunds: { $elemMatch: { paymentId: entity.payment_id, status: 'pending' } } },
      { $set: update },
    );
  }
  if (result.matchedCount === 0) {
    logger.warn(
      { refundId: entity.id, paymentId: entity.payment_id },
      'Webhook for unknown refund',
    );
  }
}
