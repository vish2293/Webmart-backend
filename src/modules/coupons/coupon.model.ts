import { model, Schema, type Types } from 'mongoose';

export const couponTypes = ['percent', 'fixed'] as const;
export type CouponType = (typeof couponTypes)[number];

export interface CouponRecord {
  _id: Types.ObjectId;
  /** Upper-case, unique; what customers type. */
  code: string;
  description?: string;
  type: CouponType;
  /** Percent (1-100) or rupees off, depending on `type`. */
  value: number;
  /** Percent coupons only: the most rupees a single order can get off. */
  maxDiscount?: number;
  /** Items total (before any discount) an order needs to use the coupon. */
  minOrderValue: number;
  startsAt?: Date;
  expiresAt?: Date;
  /** Total redemptions across all customers; unlimited when unset. */
  usageLimit?: number;
  /** Redemptions allowed per customer. */
  perUserLimit: number;
  /** Orders currently holding this coupon; goes back down when an order is cancelled. */
  usedCount: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const couponSchema = new Schema<CouponRecord>(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: { type: String, trim: true, maxlength: 200 },
    type: { type: String, required: true, enum: couponTypes },
    value: { type: Number, required: true, min: 0 },
    maxDiscount: { type: Number, min: 0 },
    minOrderValue: { type: Number, required: true, default: 0, min: 0 },
    startsAt: Date,
    expiresAt: Date,
    usageLimit: { type: Number, min: 1 },
    perUserLimit: { type: Number, required: true, default: 1, min: 1 },
    usedCount: { type: Number, required: true, default: 0, min: 0 },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);
// Admin list, newest first.
couponSchema.index({ createdAt: -1 });

export const Coupon = model<CouponRecord>('Coupon', couponSchema);

export interface CouponRedemptionRecord {
  _id: Types.ObjectId;
  coupon: Types.ObjectId;
  user: Types.ObjectId;
  order: Types.ObjectId;
  /** Set when the order was cancelled and the coupon given back. */
  releasedAt?: Date;
  createdAt: Date;
}

const redemptionSchema = new Schema<CouponRedemptionRecord>(
  {
    coupon: { type: Schema.Types.ObjectId, required: true, ref: 'Coupon' },
    user: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    // One redemption per order: claiming or releasing twice is a no-op.
    order: { type: Schema.Types.ObjectId, required: true, ref: 'Order', unique: true },
    releasedAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
redemptionSchema.index({ coupon: 1, user: 1 });

export const CouponRedemption = model<CouponRedemptionRecord>('CouponRedemption', redemptionSchema);

export interface CouponUsageRecord {
  coupon: Types.ObjectId;
  user: Types.ObjectId;
  count: number;
}

const usageSchema = new Schema<CouponUsageRecord>({
  coupon: { type: Schema.Types.ObjectId, required: true, ref: 'Coupon' },
  user: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  count: { type: Number, required: true, default: 0, min: 0 },
});
// The per-customer counter. Unique, so the "claim if under the limit" upsert can't double-insert.
usageSchema.index({ coupon: 1, user: 1 }, { unique: true });

export const CouponUsage = model<CouponUsageRecord>('CouponUsage', usageSchema);
