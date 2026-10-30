import type { ClientSession, Types } from 'mongoose';
import { isDuplicateKeyError } from '../../lib/db.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';
import {
  Coupon,
  CouponRedemption,
  CouponUsage,
  type CouponRecord,
  type CouponType,
} from './coupon.model.js';
import type { CreateCouponInput, UpdateCouponInput } from './coupons.validation.js';

/** What pricing needs from a coupon that has already passed every eligibility check. */
export type CouponRule = {
  id: Types.ObjectId;
  code: string;
  type: CouponType;
  value: number;
  maxDiscount?: number;
};

export type CouponCheck = { ok: true; rule: CouponRule } | { ok: false; message: string };

const unavailable = (message = 'This coupon is no longer available.') =>
  new ConflictError(message, 'COUPON_UNAVAILABLE');

/**
 * Whether `code` can be used by this customer on an order whose items cost `itemsPrice`.
 * Read-only: it tells the quote what to show. The real guarantee is `claimCoupon`, which re-checks
 * the limits atomically when the order is placed.
 */
export async function checkCoupon(
  code: string,
  userId: string,
  itemsPrice: number,
  session?: ClientSession,
  now = new Date(),
): Promise<CouponCheck> {
  const coupon = await Coupon.findOne({ code })
    .session(session ?? null)
    .lean();
  // Missing and switched-off look the same, so codes can't be probed.
  if (!coupon?.isActive) return { ok: false, message: "This coupon code isn't valid." };
  if (coupon.startsAt && coupon.startsAt > now) {
    return { ok: false, message: "This coupon isn't active yet." };
  }
  if (coupon.expiresAt && coupon.expiresAt <= now) {
    return { ok: false, message: 'This coupon has expired.' };
  }
  if (itemsPrice < coupon.minOrderValue) {
    return {
      ok: false,
      message: `Add items worth ₹${coupon.minOrderValue} or more to use this coupon.`,
    };
  }
  if (coupon.usageLimit !== undefined && coupon.usedCount >= coupon.usageLimit) {
    return { ok: false, message: 'This coupon has been fully claimed.' };
  }
  const usage = await CouponUsage.findOne({ coupon: coupon._id, user: userId })
    .session(session ?? null)
    .lean();
  if ((usage?.count ?? 0) >= coupon.perUserLimit) {
    return { ok: false, message: "You've already used this coupon." };
  }

  return {
    ok: true,
    rule: {
      id: coupon._id,
      code: coupon.code,
      type: coupon.type,
      value: coupon.value,
      ...(coupon.maxDiscount !== undefined && { maxDiscount: coupon.maxDiscount }),
    },
  };
}

/**
 * Takes one use of the coupon for this order, inside the order's transaction. Both counters are
 * guarded updates, so two orders racing for the last use can't both win; the loser gets
 * COUPON_UNAVAILABLE. Idempotent per order, and also re-takes a coupon that cancellation had
 * released (an expired order brought back by a late payment).
 */
export async function claimCoupon(
  couponId: Types.ObjectId,
  userId: string,
  orderId: string,
  session: ClientSession,
) {
  const existing = await CouponRedemption.findOne({ order: orderId }).session(session).lean();
  if (existing && !existing.releasedAt) return;

  const coupon = await Coupon.findById(couponId).session(session).lean();
  if (!coupon?.isActive) throw unavailable();

  const bumped = await Coupon.updateOne(
    {
      _id: couponId,
      $or: [{ usageLimit: { $exists: false } }, { $expr: { $lt: ['$usedCount', '$usageLimit'] } }],
    },
    { $inc: { usedCount: 1 } },
    { session },
  );
  if (bumped.modifiedCount === 0) throw unavailable('This coupon has been fully claimed.');

  try {
    // Matches only while the customer is under their limit. Over it, the upsert tries to insert
    // a second (coupon, user) row, which the unique index rejects.
    await CouponUsage.updateOne(
      { coupon: couponId, user: userId, count: { $lt: coupon.perUserLimit } },
      { $inc: { count: 1 } },
      { upsert: true, session },
    );
  } catch (error) {
    if (isDuplicateKeyError(error)) throw unavailable("You've already used this coupon.");
    throw error;
  }

  if (existing) {
    await CouponRedemption.updateOne(
      { _id: existing._id },
      { $unset: { releasedAt: 1 } },
      { session },
    );
  } else {
    await CouponRedemption.create([{ coupon: couponId, user: userId, order: orderId }], {
      session,
    });
  }
}

/** Gives the coupon back when its order is cancelled. A no-op if the order had none, or already did. */
export async function releaseCoupon(
  couponId: Types.ObjectId,
  userId: string,
  orderId: string,
  session: ClientSession,
) {
  const released = await CouponRedemption.findOneAndUpdate(
    { order: orderId, releasedAt: { $exists: false } },
    { releasedAt: new Date() },
    { session },
  ).lean();
  if (!released) return;
  await Coupon.updateOne(
    { _id: couponId, usedCount: { $gt: 0 } },
    { $inc: { usedCount: -1 } },
    { session },
  );
  await CouponUsage.updateOne(
    { coupon: couponId, user: userId, count: { $gt: 0 } },
    { $inc: { count: -1 } },
    { session },
  );
}

// ---- admin

export function listCoupons() {
  return Coupon.find().sort({ createdAt: -1 }).limit(500).lean();
}

export async function createCoupon(input: CreateCouponInput) {
  try {
    return await Coupon.create(input);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new ConflictError('A coupon with this code already exists', 'COUPON_EXISTS');
    }
    throw error;
  }
}

const editableFields = [
  'description',
  'value',
  'maxDiscount',
  'minOrderValue',
  'startsAt',
  'expiresAt',
  'usageLimit',
  'perUserLimit',
  'isActive',
] as const;

export async function updateCoupon(couponId: string, input: UpdateCouponInput) {
  const current = await Coupon.findById(couponId).lean();
  if (!current) throw new NotFoundError('Coupon not found', 'COUPON_NOT_FOUND');

  // Changing the amount of a coupon people already hold would make their totals differ from what
  // they were shown; switch it off and create a new one instead.
  if (input.value !== undefined && input.value !== current.value && current.usedCount > 0) {
    throw new ConflictError(
      'This coupon has been used. Switch it off and create a new one to change its value.',
      'COUPON_IN_USE',
    );
  }
  if (current.type === 'percent' && (input.value ?? current.value) > 100) {
    throw new BadRequestError('A percentage can be at most 100', 'INVALID_COUPON');
  }

  // A null clears the field; undefined leaves it alone.
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  for (const key of editableFields) {
    const value = input[key];
    if (value === undefined) continue;
    if (value === null) unset[key] = 1;
    else set[key] = value;
  }

  const startsAt = 'startsAt' in unset ? undefined : (set.startsAt ?? current.startsAt);
  const expiresAt = 'expiresAt' in unset ? undefined : (set.expiresAt ?? current.expiresAt);
  if (startsAt && expiresAt && new Date(expiresAt as string) <= new Date(startsAt as string)) {
    throw new BadRequestError('Expiry must be after the start', 'INVALID_COUPON');
  }

  const update: Record<string, unknown> = {};
  if (Object.keys(set).length > 0) update.$set = set;
  if (Object.keys(unset).length > 0) update.$unset = unset;
  const updated = await Coupon.findByIdAndUpdate(couponId, update, {
    new: true,
    runValidators: true,
  }).lean<CouponRecord>();
  if (!updated) throw new NotFoundError('Coupon not found', 'COUPON_NOT_FOUND');
  return updated;
}

/** Only a coupon nobody has used can be deleted; otherwise switch it off to keep the history. */
export async function deleteCoupon(couponId: string) {
  if (await CouponRedemption.exists({ coupon: couponId })) {
    throw new ConflictError(
      'This coupon has been used, so it can only be switched off.',
      'COUPON_IN_USE',
    );
  }
  const deleted = await Coupon.findByIdAndDelete(couponId).select('_id').lean();
  if (!deleted) throw new NotFoundError('Coupon not found', 'COUPON_NOT_FOUND');
}
