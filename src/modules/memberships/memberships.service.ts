import { Types, type ClientSession } from 'mongoose';
import { env } from '../../config/env.js';
import {
  createRazorpayOrder,
  fetchRazorpayOrderPayments,
  fetchRazorpayPayment,
  isValidPaymentSignature,
} from '../../integrations/razorpay.js';
import { withTransaction } from '../../lib/db.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { Order } from '../orders/order.model.js';
import { toPaise } from '../orders/order-pricing.js';
import type { VerifyRazorpayPaymentInput } from '../orders/orders.validation.js';
import { notifyMembership } from '../notifications/notifications.service.js';
import { creditMembershipBonus } from '../rewards/rewards.service.js';
import { User } from '../users/user.model.js';
import { Membership, type MembershipRecord } from './membership.model.js';
import { refundDuplicateMembershipPayment } from './membership-refunds.service.js';
import {
  dayMs,
  membershipPlans,
  membershipRules,
  type MembershipPlanId,
} from './memberships.config.js';

export const isMembershipActive = (endsAt?: Date | null) =>
  endsAt !== undefined && endsAt !== null && endsAt.getTime() > Date.now();

const paymentWindowMs = () => env.ORDER_PAYMENT_WINDOW_MINUTES * 60_000;

/** The membership whose benefits apply right now (there can be several when renewed early). */
const currentFilter = (userId: string, now: Date) => ({
  user: userId,
  status: 'active' as const,
  startsAt: { $lte: now },
  endsAt: { $gt: now },
});

/**
 * Counts an order against the member's current membership. A guarded write on the membership
 * document, so a refund running at the same moment conflicts with it instead of slipping
 * through. False when no active membership matched (it expired or was refunded meanwhile).
 */
export async function claimMembershipBenefit(userId: string, session: ClientSession) {
  const result = await Membership.updateOne(
    currentFilter(userId, new Date()),
    { $inc: { benefitOrders: 1 } },
    { session },
  );
  return result.modifiedCount === 1;
}

export function listPlans() {
  return Object.entries(membershipPlans).map(([id, plan]) => ({ id, ...plan }));
}

export async function getMembershipSummary(userId: string) {
  const now = new Date();
  const user = await User.findById(userId).select('membershipEndsAt').lean();
  if (!user) throw new NotFoundError('User not found', 'USER_NOT_FOUND');

  const isMember = isMembershipActive(user.membershipEndsAt);
  const [current, savings] = await Promise.all([
    isMember ? Membership.findOne(currentFilter(userId, now)).sort({ endsAt: -1 }).lean() : null,
    Order.aggregate<{ amount: number; orders: number }>([
      {
        $match: {
          user: new Types.ObjectId(userId),
          memberBenefitsApplied: true,
          isCancelled: { $ne: true },
        },
      },
      { $group: { _id: null, amount: { $sum: '$memberSavings' }, orders: { $sum: 1 } } },
    ]),
  ]);

  const endsAt = user.membershipEndsAt;
  const daysLeft = isMember && endsAt ? Math.ceil((endsAt.getTime() - now.getTime()) / dayMs) : 0;
  const refundDeadline = current?.paidAt
    ? new Date(current.paidAt.getTime() + membershipRules.refundWindowDays * dayMs)
    : undefined;

  return {
    isMember,
    endsAt: isMember ? endsAt?.toISOString() : undefined,
    daysLeft,
    canBuy: !isMember || daysLeft <= membershipRules.renewalWindowDays,
    current: current
      ? {
          id: current._id.toString(),
          plan: current.plan,
          label: membershipPlans[current.plan].label,
          startsAt: current.startsAt?.toISOString(),
          endsAt: current.endsAt?.toISOString(),
          canRefund:
            current.benefitOrders === 0 &&
            !current.refund &&
            refundDeadline !== undefined &&
            refundDeadline > now,
          refundDeadline: refundDeadline?.toISOString(),
        }
      : null,
    savings: { amount: savings[0]?.amount ?? 0, orders: savings[0]?.orders ?? 0 },
  };
}

/** Creates (or reuses) a pending membership and its Razorpay order. */
export async function startMembershipCheckout(userId: string, planId: MembershipPlanId) {
  const now = new Date();
  const user = await User.findById(userId).select('membershipEndsAt').lean();
  if (!user) throw new NotFoundError('User not found', 'USER_NOT_FOUND');
  const endsAt = user.membershipEndsAt;
  if (isMembershipActive(endsAt) && endsAt) {
    const daysLeft = (endsAt.getTime() - now.getTime()) / dayMs;
    if (daysLeft > membershipRules.renewalWindowDays) {
      throw new ConflictError(
        `You are already a Plus member. You can renew in the last ${membershipRules.renewalWindowDays} days.`,
        'ALREADY_MEMBER',
      );
    }
  }

  const plan = membershipPlans[planId];
  const membership =
    (await Membership.findOne({
      user: userId,
      plan: planId,
      status: 'pending',
      createdAt: { $gt: new Date(now.getTime() - paymentWindowMs()) },
    })
      .sort({ createdAt: -1 })
      .lean()) ??
    (
      await Membership.create({
        user: userId,
        plan: planId,
        pricePaid: plan.price,
        durationDays: plan.durationDays,
      })
    ).toObject();

  const membershipId = membership._id.toString();
  const amountInPaise = toPaise(membership.pricePaid);
  let razorpayOrderId = membership.razorpayOrderId;

  if (!razorpayOrderId) {
    const razorpayOrder = await createRazorpayOrder({
      amountInPaise,
      receipt: membershipId,
      notes: { kind: 'membership', membershipId },
    });
    const updated = await Membership.findOneAndUpdate(
      { _id: membershipId, razorpayOrderId: { $exists: false } },
      { razorpayOrderId: razorpayOrder.id },
      { new: true },
    )
      .select('razorpayOrderId')
      .lean();
    // A concurrent request may have attached its gateway order first; use that one.
    razorpayOrderId =
      updated?.razorpayOrderId ??
      (await Membership.findById(membershipId).select('razorpayOrderId').lean())?.razorpayOrderId;
  }

  return {
    membershipId,
    keyId: env.RAZORPAY_KEY_ID,
    razorpayOrderId,
    amount: amountInPaise,
    currency: 'INR',
    label: plan.label,
  };
}

type ReceivedPayment = { id: string; method?: string };

/**
 * Marks the membership paid and starts it, once. Safe from the browser verify call, the webhook
 * and the expiry sweep in any order. A second, different payment for the same membership is
 * refunded as a duplicate. Memberships have no stock to lose, so even a payment that arrives
 * after the pending membership expired simply activates it.
 */
export async function activateMembership(
  membershipId: string,
  payment: ReceivedPayment,
): Promise<MembershipRecord> {
  const result = await withTransaction(async (session) => {
    const now = new Date();
    const claimed = await Membership.findOneAndUpdate(
      { _id: membershipId, status: { $in: ['pending', 'expired'] }, paidAt: { $exists: false } },
      { $set: { status: 'active', paymentId: payment.id, paidAt: now } },
      { new: true, session },
    ).lean();

    if (!claimed) {
      const existing = await Membership.findById(membershipId).session(session).lean();
      if (!existing) throw new NotFoundError('Membership not found', 'MEMBERSHIP_NOT_FOUND');
      return {
        membership: existing,
        isDuplicate: existing.paymentId !== payment.id,
        isNew: false,
      };
    }

    // Renewing early starts the new period when the current one ends. The user document is the
    // serialisation point: two activations for one user conflict here and retry.
    const user = await User.findById(claimed.user)
      .select('membershipEndsAt')
      .session(session)
      .lean();
    const startsAt = new Date(Math.max(now.getTime(), user?.membershipEndsAt?.getTime() ?? 0));
    const endsAt = new Date(startsAt.getTime() + claimed.durationDays * dayMs);
    const bonus = membershipRules.welcomeBonusPoints;

    const activated = await Membership.findOneAndUpdate(
      { _id: claimed._id },
      { $set: { startsAt, endsAt, welcomeBonusPoints: bonus } },
      { new: true, session },
    ).lean();
    await User.updateOne(
      { _id: claimed.user },
      { $set: { membershipEndsAt: endsAt } },
      { session },
    );
    await creditMembershipBonus(claimed.user.toString(), membershipId, bonus, session);
    return { membership: activated ?? claimed, isDuplicate: false, isNew: true };
  });

  if (result.isDuplicate) {
    logger.warn(
      { membershipId, paymentId: payment.id },
      'Duplicate payment for a membership; refunding it',
    );
    await refundDuplicateMembershipPayment(membershipId, payment.id, result.membership.pricePaid);
  }
  if (result.isNew) await notifyMembership(membershipId, 'welcome');
  return result.membership;
}

export async function verifyMembershipPayment(
  userId: string,
  membershipId: string,
  input: VerifyRazorpayPaymentInput,
) {
  const membership = await Membership.findById(membershipId).lean();
  if (!membership) throw new NotFoundError('Membership not found', 'MEMBERSHIP_NOT_FOUND');
  if (membership.user.toString() !== userId) {
    throw new NotFoundError('Membership not found', 'MEMBERSHIP_NOT_FOUND');
  }
  if (!membership.razorpayOrderId || membership.razorpayOrderId !== input.razorpay_order_id) {
    throw new BadRequestError('Payment does not belong to this membership', 'PAYMENT_MISMATCH');
  }
  const isValid = isValidPaymentSignature({
    razorpayOrderId: input.razorpay_order_id,
    razorpayPaymentId: input.razorpay_payment_id,
    signature: input.razorpay_signature,
  });
  if (!isValid) {
    throw new BadRequestError('Payment verification failed', 'PAYMENT_SIGNATURE_INVALID');
  }

  const payment = await fetchRazorpayPayment(input.razorpay_payment_id);
  if (payment.amount !== toPaise(membership.pricePaid)) {
    throw new BadRequestError('Payment amount does not match this plan', 'PAYMENT_NOT_CAPTURED');
  }
  if (payment.status === 'authorized') {
    throw new ConflictError(
      'Payment received. We are confirming it with the bank; this page will update shortly.',
      'PAYMENT_PENDING',
    );
  }
  if (payment.status !== 'captured') {
    throw new BadRequestError('Payment was not completed', 'PAYMENT_NOT_CAPTURED');
  }

  await activateMembership(membershipId, { id: payment.id, method: payment.method });
  return getMembershipSummary(userId);
}

/**
 * Webhook payment event. Returns false when the Razorpay order isn't a membership, so the caller
 * can try orders instead.
 */
export async function handleMembershipPaymentEvent(payment: {
  id: string;
  order_id: string;
  amount: number;
  method?: string | null;
}) {
  const membership = await Membership.findOne({ razorpayOrderId: payment.order_id })
    .select('pricePaid')
    .lean();
  if (!membership) return false;
  if (payment.amount !== toPaise(membership.pricePaid)) {
    logger.error(
      { membershipId: membership._id, paid: payment.amount },
      'Razorpay payment amount does not match membership price',
    );
    return true;
  }
  await activateMembership(membership._id.toString(), {
    id: payment.id,
    method: payment.method ?? undefined,
  });
  return true;
}

const expiryBatchSize = 50;

/**
 * Marks lapsed memberships expired and settles pending ones left unpaid past the payment window
 * (checking Razorpay first, so a missed webhook doesn't lose a paid membership).
 */
export async function expireMemberships(now = new Date()) {
  const lapsed = await Membership.updateMany(
    { status: 'active', endsAt: { $lt: now } },
    { $set: { status: 'expired' } },
  );

  const overdue = await Membership.find({
    status: 'pending',
    createdAt: { $lt: new Date(now.getTime() - paymentWindowMs()) },
  })
    .select('razorpayOrderId pricePaid')
    .sort({ createdAt: 1 })
    .limit(expiryBatchSize)
    .lean();

  const counts = { lapsed: lapsed.modifiedCount, activated: 0, abandoned: 0, failed: 0 };
  for (const membership of overdue) {
    try {
      const payments = membership.razorpayOrderId
        ? await fetchRazorpayOrderPayments(membership.razorpayOrderId)
        : [];
      const captured = payments.find(
        (payment) =>
          payment.status === 'captured' && payment.amount === toPaise(membership.pricePaid),
      );
      if (captured) {
        await activateMembership(membership._id.toString(), { id: captured.id });
        counts.activated += 1;
      } else if (payments.some((payment) => payment.status === 'authorized')) {
        // Razorpay will capture or void it; check again next sweep.
        continue;
      } else {
        const abandoned = await Membership.updateOne(
          { _id: membership._id, status: 'pending' },
          { $set: { status: 'expired' } },
        );
        counts.abandoned += abandoned.modifiedCount;
      }
    } catch (error) {
      counts.failed += 1;
      logger.error({ err: error, membershipId: membership._id }, 'Failed to expire membership');
    }
  }
  return counts;
}

// ponytail: unbounded-ish admin list capped at 200; paginate when memberships grow.
export function listMemberships() {
  return Membership.find().populate('user', 'name email').sort({ createdAt: -1 }).limit(200).lean();
}
