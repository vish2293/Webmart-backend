import type { ClientSession } from 'mongoose';
import { createRazorpayRefund, listRazorpayPaymentRefunds } from '../../integrations/razorpay.js';
import { createStripeRefund, findStripeRefund } from '../../integrations/stripe.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { Order, type RefundReason, type RefundRecord, type RefundStatus } from './order.model.js';
import { toPaise } from './order-pricing.js';

/** Marker payment id for cash-on-delivery money that must be returned outside the app. */
export const codPaymentId = 'cod';

/** Both gateways' refund states end up as processed / failed / still pending. */
const toRefundStatus = (gatewayStatus: string): RefundStatus =>
  gatewayStatus === 'processed' ? 'processed' : gatewayStatus === 'failed' ? 'failed' : 'pending';

/** Stripe payments are PaymentIntents (`pi_…`); Razorpay payments are `pay_…`. */
export const isStripePaymentId = (paymentId: string) => paymentId.startsWith('pi_');
/** A payment id one of the gateways can refund; anything else (cash, admin-entered) is manual. */
export const isGatewayPaymentId = (paymentId: string | undefined): paymentId is string =>
  paymentId !== undefined && (paymentId.startsWith('pay_') || isStripePaymentId(paymentId));

/** Finds the live refund for a payment or creates it, at whichever gateway took the money. */
async function refundAtGateway(
  paymentId: string,
  amount: number,
  orderId: string,
  reason: RefundReason,
): Promise<{ id: string; status: string }> {
  if (isStripePaymentId(paymentId)) {
    return (
      (await findStripeRefund(paymentId)) ??
      (await createStripeRefund({
        paymentIntentId: paymentId,
        amountInPaise: toPaise(amount),
        orderId,
        reason,
      }))
    );
  }
  // If an earlier attempt reached Razorpay but we crashed before saving, reuse that refund
  // instead of refunding the customer twice.
  const existing = (await listRazorpayPaymentRefunds(paymentId)).find(
    (refund) => refund.status !== 'failed',
  );
  return (
    existing ??
    (await createRazorpayRefund({
      paymentId,
      amountInPaise: toPaise(amount),
      notes: { orderId, reason },
    }))
  );
}

async function findRefund(orderId: string, paymentId: string): Promise<RefundRecord> {
  const order = await Order.findById(orderId).select('refunds').lean();
  const refund = order?.refunds?.find((entry) => entry.paymentId === paymentId);
  if (!refund) throw new NotFoundError('Refund not found', 'REFUND_NOT_FOUND');
  return refund;
}

/**
 * Updates the refund entry for `paymentId`. With `onlyIfPending`, the update is skipped when a
 * webhook already settled the entry, so a slower save can't overwrite the bank's answer.
 */
async function updateRefund(
  orderId: string,
  paymentId: string,
  set: Partial<RefundRecord>,
  {
    unset = [],
    onlyIfPending = false,
  }: { unset?: (keyof RefundRecord)[]; onlyIfPending?: boolean } = {},
) {
  const prefix = (field: string) => `refunds.$[entry].${field}`;
  await Order.updateOne(
    { _id: orderId },
    {
      $set: Object.fromEntries(Object.entries(set).map(([key, value]) => [prefix(key), value])),
      ...(unset.length > 0 && { $unset: Object.fromEntries(unset.map((key) => [prefix(key), 1])) }),
    },
    {
      arrayFilters: [
        { 'entry.paymentId': paymentId, ...(onlyIfPending && { 'entry.status': 'pending' }) },
      ],
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
    const refund = await refundAtGateway(paymentId, amount, orderId, reason);
    const status = toRefundStatus(refund.status);
    // The id is always recorded; the status only if no webhook has settled it in the meantime.
    await updateRefund(orderId, paymentId, { razorpayRefundId: refund.id });
    await updateRefund(
      orderId,
      paymentId,
      { status, ...(status === 'processed' && { processedAt: new Date() }) },
      { unset: ['failureReason'], onlyIfPending: true },
    );
  } catch (error) {
    logger.error({ err: error, orderId, paymentId }, 'Gateway refund failed; an admin can retry');
    await updateRefund(
      orderId,
      paymentId,
      { status: 'failed', failureReason: error instanceof Error ? error.message : 'Refund failed' },
      { onlyIfPending: true },
    );
  }
  return findRefund(orderId, paymentId);
}

type RefundRequest = {
  orderId: string;
  paymentId: string;
  amount: number;
  reason: RefundReason;
};

/**
 * Records that this payment must be refunded (a 'pending' entry), once per payment. Pass the
 * session to claim it in the same transaction as the cancel/refund that requires it, so the
 * obligation can never be lost between the two. Returns false if it was already claimed.
 */
export async function claimRefund(request: RefundRequest, session?: ClientSession) {
  const { orderId, paymentId, amount, reason } = request;
  const claimed = await Order.updateOne(
    { _id: orderId, 'refunds.paymentId': { $ne: paymentId } },
    {
      $push: {
        refunds: { paymentId, amount, status: 'pending', reason, requestedAt: new Date() },
      },
    },
    { session },
  );
  return claimed.modifiedCount === 1;
}

/** Sends an already-claimed refund to the gateway (after the claiming transaction commits). */
export async function submitClaimedRefund(orderId: string, paymentId: string) {
  const entry = await findRefund(orderId, paymentId);
  return submitRefund(orderId, paymentId, entry.amount, entry.reason);
}

/**
 * Refunds one payment in full. Idempotent per payment: the first caller claims it by adding a
 * 'pending' entry; anyone else (double click, concurrent cancel) gets that same entry back.
 */
export async function refundPayment(request: RefundRequest): Promise<RefundRecord> {
  if (!(await claimRefund(request))) return findRefund(request.orderId, request.paymentId);
  return submitRefund(request.orderId, request.paymentId, request.amount, request.reason);
}

/** A 'pending' entry that never reached Razorpay this long after the claim was interrupted. */
const stalePendingMs = 5 * 60_000;

/**
 * Admin retry of a failed refund, or of one stuck 'pending' because the process stopped before
 * calling Razorpay. Safe either way: submitRefund reuses any refund Razorpay already has.
 */
export async function retryFailedRefund(orderId: string, paymentId: string) {
  const staleBefore = new Date(Date.now() - stalePendingMs);
  const claimed = await Order.findOneAndUpdate(
    {
      _id: orderId,
      refunds: {
        $elemMatch: {
          paymentId,
          $or: [
            { status: 'failed' },
            {
              status: 'pending',
              razorpayRefundId: { $exists: false },
              requestedAt: { $lt: staleBefore },
            },
          ],
        },
      },
    },
    // Re-arming requestedAt stops a second concurrent retry from also claiming it.
    { $set: { 'refunds.$.status': 'pending', 'refunds.$.requestedAt': new Date() } },
    { new: true },
  ).lean();
  const entry = claimed?.refunds.find((refund) => refund.paymentId === paymentId);
  if (!entry) {
    throw new ConflictError('Only failed or stuck refunds can be retried', 'REFUND_NOT_RETRYABLE');
  }
  return submitRefund(orderId, paymentId, entry.amount, entry.reason);
}

/** Cash-on-delivery payments can't go back through a gateway; flag them for the admin. */
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
 * Gateway refund events (Razorpay or Stripe). Matched by refund id, or — when the webhook beats our own save of
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
