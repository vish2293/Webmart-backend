import { model, Schema, type Types } from 'mongoose';
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
  itemsPrice: number;
  taxPrice: number;
  shippingPrice: number;
  totalPrice: number;
  isPaid: boolean;
  paidAt?: Date;
  isDelivered: boolean;
  deliveredAt?: Date;
  /** Set when an unpaid online order expires; its stock has been returned. */
  isCancelled: boolean;
  cancelledAt?: Date;
  /** Client-generated key that makes "place order" safe to retry. Unique per user. */
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const orderSchema = new Schema<OrderRecord>(
  {
    user: { type: Schema.Types.ObjectId, required: true, ref: 'User', index: true },
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
    paymentResult: {
      id: String,
      status: String,
      update_time: String,
      email_address: String,
    },
    itemsPrice: { type: Number, required: true, default: 0 },
    taxPrice: { type: Number, required: true, default: 0 },
    shippingPrice: { type: Number, required: true, default: 0 },
    totalPrice: { type: Number, required: true, default: 0 },
    isPaid: { type: Boolean, required: true, default: false },
    paidAt: Date,
    isDelivered: { type: Boolean, required: true, default: false },
    deliveredAt: Date,
    isCancelled: { type: Boolean, required: true, default: false },
    cancelledAt: Date,
    idempotencyKey: String,
  },
  { timestamps: true },
);

orderSchema.index(
  { user: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
// Supports the expiry sweep over unpaid orders.
orderSchema.index({ isPaid: 1, isCancelled: 1, createdAt: 1 });

/** Orders created before `isCancelled` existed have no such field, so match "not true". */
export const notCancelled = { isCancelled: { $ne: true } } as const;

export const Order = model<OrderRecord>('Order', orderSchema);
