import { model, Schema, type Types } from 'mongoose';
import { membershipPlanIds, type MembershipPlanId } from './memberships.config.js';

export const membershipStatuses = ['pending', 'active', 'expired', 'refunded'] as const;
export type MembershipStatus = (typeof membershipStatuses)[number];

export const membershipRefundStatuses = ['pending', 'processed', 'failed'] as const;
export type MembershipRefundStatus = (typeof membershipRefundStatuses)[number];

export interface MembershipRefundRecord {
  status: MembershipRefundStatus;
  amount: number;
  reason: 'customer_cancel' | 'admin_refund' | 'duplicate_payment';
  razorpayRefundId?: string;
  requestedAt: Date;
  processedAt?: Date;
  failureReason?: string;
}

export interface MembershipRecord {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  plan: MembershipPlanId;
  /** pending: awaiting payment. active/expired: paid (expired once `endsAt` passed). */
  status: MembershipStatus;
  /** Snapshot, so later price changes never rewrite what a member paid. */
  pricePaid: number;
  durationDays: number;
  razorpayOrderId?: string;
  paymentId?: string;
  paidAt?: Date;
  startsAt?: Date;
  endsAt?: Date;
  /** Orders that used this membership's benefits; any makes it ineligible for a self-service refund. */
  benefitOrders: number;
  welcomeBonusPoints: number;
  refund?: MembershipRefundRecord;
  createdAt: Date;
  updatedAt: Date;
}

const membershipSchema = new Schema<MembershipRecord>(
  {
    user: { type: Schema.Types.ObjectId, required: true, ref: 'User', index: true },
    plan: { type: String, required: true, enum: membershipPlanIds },
    status: {
      type: String,
      required: true,
      enum: membershipStatuses,
      default: 'pending',
    },
    pricePaid: { type: Number, required: true, min: 0 },
    durationDays: { type: Number, required: true, min: 1 },
    razorpayOrderId: { type: String, unique: true, sparse: true },
    paymentId: String,
    paidAt: Date,
    startsAt: Date,
    endsAt: Date,
    benefitOrders: { type: Number, required: true, default: 0, min: 0 },
    welcomeBonusPoints: { type: Number, required: true, default: 0, min: 0 },
    refund: {
      _id: false,
      status: { type: String, enum: membershipRefundStatuses },
      amount: { type: Number, min: 0 },
      reason: { type: String, enum: ['customer_cancel', 'admin_refund', 'duplicate_payment'] },
      razorpayRefundId: String,
      requestedAt: Date,
      processedAt: Date,
      failureReason: String,
    },
  },
  { timestamps: true },
);

// Expiry sweeps scan by status and date.
membershipSchema.index({ status: 1, endsAt: 1 });
membershipSchema.index({ status: 1, createdAt: 1 });
// Refund webhooks look memberships up by Razorpay refund id or payment id.
membershipSchema.index({ 'refund.razorpayRefundId': 1 }, { sparse: true });
membershipSchema.index({ paymentId: 1 }, { sparse: true });

export const Membership = model<MembershipRecord>('Membership', membershipSchema);
