import type { ClientSession } from 'mongoose';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { notCancelled, Order } from '../orders/order.model.js';
import { User } from '../users/user.model.js';
import { PointsTransaction, type PointsTransactionType } from './points-transaction.model.js';

// Every mutation below runs inside the caller's transaction. The user's balance is updated
// *before* the ledger row is written: concurrent point operations for one user then collide on
// the user document (a transient write conflict the driver retries against fresh data) rather
// than on the ledger's unique index (a duplicate-key error that would fail the request).

function findEntry(orderId: string, type: PointsTransactionType, session: ClientSession) {
  return PointsTransaction.findOne({ order: orderId, type }).session(session).lean();
}

async function writeEntry(
  userId: string,
  orderId: string,
  type: PointsTransactionType,
  points: number,
  session: ClientSession,
  shortfall?: number,
) {
  await PointsTransaction.create([{ user: userId, order: orderId, type, points, shortfall }], {
    session,
  });
}

export async function isFirstOrderEligible(userId: string, session?: ClientSession) {
  const user = await User.findById(userId)
    .select('firstOrderDiscountUsedAt')
    .session(session ?? null)
    .lean();
  if (!user || user.firstOrderDiscountUsedAt) return false;
  // Customers who ordered before this feature existed have no flag but aren't new.
  const hasOrdered = await Order.exists({ user: userId, ...notCancelled }).session(session ?? null);
  return !hasOrdered;
}

/** Marks the discount used. False if another order claimed it first. */
export async function claimFirstOrderDiscount(userId: string, session: ClientSession) {
  const result = await User.updateOne(
    { _id: userId, firstOrderDiscountUsedAt: { $exists: false } },
    { $set: { firstOrderDiscountUsedAt: new Date() } },
    { session },
  );
  return result.modifiedCount === 1;
}

export async function releaseFirstOrderDiscount(userId: string, session: ClientSession) {
  await User.updateOne({ _id: userId }, { $unset: { firstOrderDiscountUsedAt: 1 } }, { session });
}

/** Never lets the balance go below zero; a shortfall means the customer's view was stale. */
export async function spendPoints(
  userId: string,
  orderId: string,
  points: number,
  session: ClientSession,
  type: 'redeem' | 'revive_redeem' = 'redeem',
) {
  if (points <= 0) return;
  const result = await User.updateOne(
    { _id: userId, pointsBalance: { $gte: points } },
    { $inc: { pointsBalance: -points } },
    { session },
  );
  if (result.modifiedCount === 0) {
    throw new ConflictError(
      'Your points balance changed. Please review your order.',
      'PRICE_CHANGED',
    );
  }
  await writeEntry(userId, orderId, type, -points, session);
}

/** Returns the points currently spent on the order (if any) and how many were returned. */
export async function returnSpentPoints(userId: string, orderId: string, session: ClientSession) {
  for (const [spendType, returnType] of [
    ['revive_redeem', 'revive_return'],
    ['redeem', 'redeem_return'],
  ] as const) {
    const spent = await findEntry(orderId, spendType, session);
    if (!spent) continue;
    if (await findEntry(orderId, returnType, session)) {
      // The latest spend is already returned; nothing outstanding.
      return 0;
    }
    const points = -spent.points;
    await User.updateOne({ _id: userId }, { $inc: { pointsBalance: points } }, { session });
    await writeEntry(userId, orderId, returnType, points, session);
    return points;
  }
  return 0;
}

export async function creditEarnedPoints(
  userId: string,
  orderId: string,
  points: number,
  session: ClientSession,
) {
  if (points <= 0 || (await findEntry(orderId, 'earn', session))) return;
  await User.updateOne({ _id: userId }, { $inc: { pointsBalance: points } }, { session });
  await writeEntry(userId, orderId, 'earn', points, session);
}

/** Takes back points earned on a refunded order, flooring the balance at zero. */
export async function revokeEarnedPoints(userId: string, orderId: string, session: ClientSession) {
  const earned = await findEntry(orderId, 'earn', session);
  if (!earned || (await findEntry(orderId, 'earn_revoke', session))) {
    return { revoked: 0, shortfall: 0 };
  }
  const user = await User.findById(userId).select('pointsBalance').session(session).lean();
  if (!user) throw new NotFoundError('User not found', 'USER_NOT_FOUND');

  const revoked = Math.min(earned.points, user.pointsBalance);
  const shortfall = earned.points - revoked;
  await User.updateOne({ _id: userId }, { $inc: { pointsBalance: -revoked } }, { session });
  await writeEntry(userId, orderId, 'earn_revoke', -revoked, session, shortfall);
  return { revoked, shortfall };
}

const historyLimit = 20;

export async function getRewardsSummary(userId: string) {
  const user = await User.findById(userId).select('pointsBalance').lean();
  if (!user) throw new NotFoundError('User not found', 'USER_NOT_FOUND');

  const [isEligible, history] = await Promise.all([
    isFirstOrderEligible(userId),
    PointsTransaction.find({ user: userId })
      .select('type points order createdAt')
      .sort({ createdAt: -1 })
      .limit(historyLimit)
      .lean(),
  ]);

  return {
    pointsBalance: user.pointsBalance ?? 0,
    isFirstOrderEligible: isEligible,
    history: history.map((entry) => ({
      type: entry.type,
      points: entry.points,
      order: entry.order.toString(),
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}
