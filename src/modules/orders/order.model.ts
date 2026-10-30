import { model, Schema, type Types } from 'mongoose';
import type { DeliveryOption } from './order-pricing.js';
import { deliveryOptions } from './order-pricing.js';
import type { PaymentMethod } from './orders.validation.js';

export interface OrderItemRecord {
  product: Types.ObjectId;
  name: string;
  image: string;
  price: number;
  qty: number;
}

export interface ShippingAddressRecord {
  address: string;
  city: string;
  postalCode: string;
  country: string;
}

export interface PaymentResultRecord {
  id?: string;
  status?: string;
  update_time?: string;
  email_address?: string;
  /** Gateway payment method: upi, card, netbanking, wallet, … */
  method?: string;
}

export const cancelReasons = ['payment_expired', 'customer', 'admin'] as const;
export type CancelReason = (typeof cancelReasons)[number];

export const refundStatuses = ['pending', 'processed', 'failed', 'manual_required'] as const;
export type RefundStatus = (typeof refundStatuses)[number];

export const refundReasons = [
  'customer_cancel',
  'admin_cancel',
  'admin_refund',
  'late_payment',
  'duplicate_payment',
] as const;
export type RefundReason = (typeof refundReasons)[number];

/** One per refunded payment. `paymentId` is 'cod' for cash refunds settled outside the app. */
export interface RefundRecord {
  paymentId: string;
  amount: number;
  status: RefundStatus;
  /** Gateway refund id: Razorpay `rfnd_…` or Stripe `re_…`. */
  razorpayRefundId?: string;
  reason: RefundReason;
  requestedAt: Date;
  processedAt?: Date;
  failureReason?: string;
}

export interface OrderRecord {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  orderItems: OrderItemRecord[];
  shippingAddress: ShippingAddressRecord;
  paymentMethod: PaymentMethod;
  paymentResult?: PaymentResultRecord;
  /** Gateway order created when the customer starts an online payment. */
  razorpayOrderId?: string;
  /** Latest Stripe Checkout Session for this order (a new one replaces an expired one). */
  stripeCheckoutSessionId?: string;
  itemsPrice: number;
  firstOrderDiscount: number;
  /** The coupon used and what it took off; `coupon` lets cancellation give it back. */
  coupon?: Types.ObjectId;
  couponCode?: string;
  couponDiscount: number;
  pointsRedeemed: number;
  pointsDiscount: number;
  /** Points credited once the order was paid and delivered. */
  pointsEarned: number;
  pointsEarnedAt?: Date;
  taxPrice: number;
  shippingPrice: number;
  deliveryOption: DeliveryOption;
  expressDeliveryPrice: number;
  /** Plus benefits were applied to this order (snapshot at order time). */
  memberBenefitsApplied: boolean;
  /** Shipping and express fees Plus waived on this order. */
  memberSavings: number;
  /** 2 for Plus members; applied when the points are earned. */
  pointsMultiplier: number;
  estimatedDeliveryDate?: Date;
  totalPrice: number;
  isPaid: boolean;
  paidAt?: Date;
  isShipped: boolean;
  shippedAt?: Date;
  isDelivered: boolean;
  deliveredAt?: Date;
  /** Cancelled orders have their stock, spent points and first-order discount returned. */
  isCancelled: boolean;
  cancelledAt?: Date;
  cancelReason?: CancelReason;
  /** Set when an admin refunds a shipped order; the order is then closed for fulfilment. */
  refundedAt?: Date;
  refunds: RefundRecord[];
  /** Client-generated key that makes "place order" safe to retry. Unique per user. */
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const orderSchema = new Schema<OrderRecord>(
  {
    user: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    orderItems: [
      {
        // Name, image and price are snapshotted so later product edits don't rewrite history.
        name: { type: String, required: true },
        qty: { type: Number, required: true, min: 1 },
        image: { type: String, required: true },
        price: { type: Number, required: true, min: 0 },
        product: { type: Schema.Types.ObjectId, required: true, ref: 'Product' },
      },
    ],
    shippingAddress: {
      address: { type: String, required: true },
      city: { type: String, required: true },
      postalCode: { type: String, required: true },
      country: { type: String, required: true },
    },
    paymentMethod: { type: String, required: true },
    razorpayOrderId: { type: String, unique: true, sparse: true },
    stripeCheckoutSessionId: { type: String, unique: true, sparse: true },
    paymentResult: {
      id: String,
      status: String,
      update_time: String,
      email_address: String,
      method: String,
    },
    itemsPrice: { type: Number, required: true, default: 0 },
    firstOrderDiscount: { type: Number, required: true, default: 0, min: 0 },
    coupon: { type: Schema.Types.ObjectId, ref: 'Coupon' },
    couponCode: String,
    couponDiscount: { type: Number, required: true, default: 0, min: 0 },
    pointsRedeemed: { type: Number, required: true, default: 0, min: 0 },
    pointsDiscount: { type: Number, required: true, default: 0, min: 0 },
    pointsEarned: { type: Number, required: true, default: 0, min: 0 },
    pointsEarnedAt: Date,
    taxPrice: { type: Number, required: true, default: 0 },
    shippingPrice: { type: Number, required: true, default: 0 },
    deliveryOption: { type: String, required: true, enum: deliveryOptions, default: 'standard' },
    expressDeliveryPrice: { type: Number, required: true, default: 0, min: 0 },
    memberBenefitsApplied: { type: Boolean, required: true, default: false },
    memberSavings: { type: Number, required: true, default: 0, min: 0 },
    pointsMultiplier: { type: Number, required: true, default: 1, min: 1 },
    estimatedDeliveryDate: Date,
    totalPrice: { type: Number, required: true, default: 0 },
    isPaid: { type: Boolean, required: true, default: false },
    paidAt: Date,
    isShipped: { type: Boolean, required: true, default: false },
    shippedAt: Date,
    isDelivered: { type: Boolean, required: true, default: false },
    deliveredAt: Date,
    isCancelled: { type: Boolean, required: true, default: false },
    cancelledAt: Date,
    cancelReason: { type: String, enum: cancelReasons },
    refundedAt: Date,
    refunds: [
      {
        _id: false,
        paymentId: { type: String, required: true },
        amount: { type: Number, required: true, min: 0 },
        status: { type: String, required: true, enum: refundStatuses },
        razorpayRefundId: String,
        reason: { type: String, required: true, enum: refundReasons },
        requestedAt: { type: Date, required: true },
        processedAt: Date,
        failureReason: String,
      },
    ],
    idempotencyKey: String,
  },
  { timestamps: true },
);

orderSchema.index(
  { user: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
// "My orders" (newest first); its user prefix also serves every other per-customer lookup
// (open-order limit, first-order check, Plus savings, review eligibility).
orderSchema.index({ user: 1, createdAt: -1 });
// The admin list of all orders, newest first.
orderSchema.index({ createdAt: -1 });
// Supports the expiry sweep over unpaid orders.
orderSchema.index({ isPaid: 1, isCancelled: 1, createdAt: 1 });
// Refund webhooks look orders up by Razorpay refund id or payment id.
orderSchema.index({ 'refunds.razorpayRefundId': 1 }, { sparse: true });
orderSchema.index({ 'refunds.paymentId': 1 });

/** Orders created before `isCancelled` existed have no such field, so match "not true". */
export const notCancelled = { isCancelled: { $ne: true } } as const;

export const Order = model<OrderRecord>('Order', orderSchema);
