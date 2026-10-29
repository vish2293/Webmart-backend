import { model, Schema, type Types } from 'mongoose';

/**
 * - earn / earn_revoke: credited when an order completes; removed if it's refunded later.
 * - redeem / redeem_return: spent at checkout; returned on cancel or refund.
 * - revive_redeem / revive_return: the same pair again for an expired order that a late payment
 *   brought back (an order can be revived at most once).
 * - membership_bonus / membership_bonus_revoke: the Plus welcome bonus and its removal on refund.
 *   For these two types `order` holds the membership id, so the (order, type) index keeps
 *   them once-only too.
 */
export const pointsTransactionTypes = [
  'earn',
  'earn_revoke',
  'redeem',
  'redeem_return',
  'revive_redeem',
  'revive_return',
  'membership_bonus',
  'membership_bonus_revoke',
] as const;
export type PointsTransactionType = (typeof pointsTransactionTypes)[number];

export interface PointsTransactionRecord {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  order: Types.ObjectId;
  type: PointsTransactionType;
  /** Signed change to the balance. */
  points: number;
  /** earn_revoke only: points that couldn't be taken back because they were already spent. */
  shortfall?: number;
  createdAt: Date;
}

const pointsTransactionSchema = new Schema<PointsTransactionRecord>(
  {
    user: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    order: { type: Schema.Types.ObjectId, required: true, ref: 'Order' },
    type: { type: String, required: true, enum: pointsTransactionTypes },
    points: { type: Number, required: true },
    shortfall: Number,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Each kind of movement happens at most once per order, so retries can't double-apply.
pointsTransactionSchema.index({ order: 1, type: 1 }, { unique: true });
pointsTransactionSchema.index({ user: 1, createdAt: -1 });

export const PointsTransaction = model<PointsTransactionRecord>(
  'PointsTransaction',
  pointsTransactionSchema,
);
