import { createRazorpayRefund, listRazorpayPaymentRefunds } from '../../integrations/razorpay.js';
import { withTransaction } from '../../lib/db.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { notifyMembership } from '../notifications/notifications.service.js';
import { toPaise } from '../orders/order-pricing.js';
import { revokeMembershipBonus } from '../rewards/rewards.service.js';
import { User } from '../users/user.model.js';
import { Membership, type MembershipRecord } from './membership.model.js';
import { dayMs, membershipRules } from './memberships.config.js';

type Actor = { kind: 'customer'; userId: string } | { kind: 'admin' };

const toRefundStatus = (razorpayStatus: string) =>
  razorpayStatus === 'processed' ? 'processed' : razorpayStatus === 'failed' ? 'failed' : 'pending';

async function loadMembership(membershipId: string): Promise<MembershipRecord> {
  const membership = await Membership.findById(membershipId).lean();
  if (!membership) throw new NotFoundError('Membership not found', 'MEMBERSHIP_NOT_FOUND');
  return membership;
}

/**
 * Cancels an active membership and refunds it in full. Customers need the refund window to be
 * open and no order to have used the benefits; admins can always refund.
 *
 * The cancel, the removal of the remaining membership time and the welcome points, and the
 * refund claim commit together; Razorpay is called only afterwards, so the refund obligation
 * can't be lost. A failed gateway call leaves the refund 'failed' for an admin to retry.
 */
export async function refundMembership(
  membershipId: string,
  actor: Actor,
  reason: 'customer_cancel' | 'admin_refund' = actor.kind === 'admin'
    ? 'admin_refund'
    : 'customer_cancel',
) {
  await withTransaction(async (session) => {
    const now = new Date();
    const membership = await Membership.findById(membershipId).session(session).lean();
    if (!membership) throw new NotFoundError('Membership not found', 'MEMBERSHIP_NOT_FOUND');
    if (actor.kind === 'customer' && membership.user.toString() !== actor.userId) {
      throw new ForbiddenError('You can only cancel your own membership', 'MEMBERSHIP_FORBIDDEN');
    }
    if (membership.status !== 'active' || membership.refund || !membership.paymentId) {
      throw new ConflictError(
        'This membership can no longer be refunded',
        'MEMBERSHIP_NOT_REFUNDABLE',
      );
    }
    if (actor.kind === 'customer') {
      if (membership.benefitOrders > 0) {
        throw new ConflictError(
          'Plus benefits were already used on an order, so this membership cannot be cancelled for a refund.',
          'MEMBERSHIP_BENEFITS_USED',
        );
      }
      const deadline =
        (membership.paidAt?.getTime() ?? 0) + membershipRules.refundWindowDays * dayMs;
      if (deadline < now.getTime()) {
        throw new ConflictError(
          `The ${membershipRules.refundWindowDays}-day refund window has passed.`,
          'MEMBERSHIP_REFUND_WINDOW_CLOSED',
        );
      }
    }

    const claimed = await Membership.findOneAndUpdate(
      {
        _id: membershipId,
        status: 'active',
        refund: { $exists: false },
        ...(actor.kind === 'customer' && { benefitOrders: 0 }),
      },
      {
        $set: {
          status: 'refunded',
          refund: { status: 'pending', amount: membership.pricePaid, reason, requestedAt: now },
        },
      },
      { new: true, session },
    ).lean();
    if (!claimed) {
      throw new ConflictError(
        'The membership changed. Please reload and try again.',
        'MEMBERSHIP_CHANGED',
      );
    }

    // Takes this membership's time back off the user's end date (renewals stack, so subtract
    // rather than reset). ponytail: refunding an early one of two stacked memberships shortens
    // the later one's start; acceptable because refunds are rare and short-windowed.
    const userId = membership.user.toString();
    const user = await User.findById(userId).select('membershipEndsAt').session(session).lean();
    const lengthMs = (membership.durationDays ?? 0) * dayMs;
    const newEnd = (user?.membershipEndsAt?.getTime() ?? 0) - lengthMs;
    await User.updateOne(
      { _id: userId },
      newEnd > now.getTime()
        ? { $set: { membershipEndsAt: new Date(newEnd) } }
        : { $unset: { membershipEndsAt: 1 } },
      { session },
    );
    await revokeMembershipBonus(userId, membershipId, session);
  });

  await submitMembershipRefund(membershipId);
  await notifyMembership(membershipId, 'refunded');
  return loadMembership(membershipId);
}

/** Sends a claimed ('pending') refund to Razorpay. Gateway errors mark it 'failed', not thrown. */
async function submitMembershipRefund(membershipId: string) {
  const membership = await loadMembership(membershipId);
  const { paymentId, refund } = membership;
  if (!paymentId || !refund) return;

  try {
    // If an earlier attempt reached Razorpay but we crashed before saving, reuse that refund.
    const existing = (await listRazorpayPaymentRefunds(paymentId)).find(
      (entry) => entry.status !== 'failed',
    );
    const razorpayRefund =
      existing ??
      (await createRazorpayRefund({
        paymentId,
        amountInPaise: toPaise(refund.amount),
        notes: { membershipId, reason: refund.reason },
      }));
    const status = toRefundStatus(razorpayRefund.status);
    // The id is always recorded; the status only if no webhook has settled it in the meantime.
    await Membership.updateOne(
      { _id: membershipId },
      { $set: { 'refund.razorpayRefundId': razorpayRefund.id } },
    );
    await Membership.updateOne(
      { _id: membershipId, 'refund.status': 'pending' },
      {
        $set: {
          'refund.status': status,
          ...(status === 'processed' && { 'refund.processedAt': new Date() }),
        },
        $unset: { 'refund.failureReason': 1 },
      },
    );
  } catch (error) {
    logger.error({ err: error, membershipId }, 'Membership refund failed; an admin can retry');
    await Membership.updateOne(
      { _id: membershipId, 'refund.status': 'pending' },
      {
        $set: {
          'refund.status': 'failed',
          'refund.failureReason': error instanceof Error ? error.message : 'Refund failed',
        },
      },
    );
  }
}

/** A 'pending' refund that never reached Razorpay this long after the claim was interrupted. */
const stalePendingMs = 5 * 60_000;

/** Admin retry of a failed refund, or one stuck 'pending' because the process stopped. */
export async function retryMembershipRefund(membershipId: string) {
  const claimed = await Membership.findOneAndUpdate(
    {
      _id: membershipId,
      status: 'refunded',
      $or: [
        { 'refund.status': 'failed' },
        {
          'refund.status': 'pending',
          'refund.razorpayRefundId': { $exists: false },
          'refund.requestedAt': { $lt: new Date(Date.now() - stalePendingMs) },
        },
      ],
    },
    // Re-arming requestedAt stops a second concurrent retry from also claiming it.
    { $set: { 'refund.status': 'pending', 'refund.requestedAt': new Date() } },
    { new: true },
  ).lean();
  if (!claimed) {
    throw new ConflictError('Only failed or stuck refunds can be retried', 'REFUND_NOT_RETRYABLE');
  }
  await submitMembershipRefund(membershipId);
  return loadMembership(membershipId);
}

/**
 * A second payment landed on an already-paid membership: give it back. Best effort; the error is
 * logged so an admin can refund it from the Razorpay dashboard if the call fails.
 */
export async function refundDuplicateMembershipPayment(
  membershipId: string,
  paymentId: string,
  amount: number,
) {
  try {
    const existing = (await listRazorpayPaymentRefunds(paymentId)).find(
      (entry) => entry.status !== 'failed',
    );
    if (existing) return;
    await createRazorpayRefund({
      paymentId,
      amountInPaise: toPaise(amount),
      notes: { membershipId, reason: 'duplicate_payment' },
    });
  } catch (error) {
    logger.error(
      { err: error, membershipId, paymentId },
      'Could not refund a duplicate membership payment; refund it in the Razorpay dashboard',
    );
  }
}

/** Razorpay refund events for membership refunds. False if the refund isn't a membership's. */
export async function applyMembershipRefundWebhook(
  entity: { id: string; payment_id: string },
  event: 'refund.processed' | 'refund.failed',
) {
  const isProcessed = event === 'refund.processed';
  const update = {
    'refund.status': isProcessed ? 'processed' : 'failed',
    'refund.razorpayRefundId': entity.id,
    ...(isProcessed
      ? { 'refund.processedAt': new Date() }
      : { 'refund.failureReason': 'Refund failed at the bank' }),
  };
  let result = await Membership.updateOne(
    { 'refund.razorpayRefundId': entity.id },
    { $set: update },
  );
  if (result.matchedCount === 0) {
    result = await Membership.updateOne(
      { paymentId: entity.payment_id, 'refund.status': 'pending' },
      { $set: update },
    );
  }
  return result.matchedCount > 0;
}
