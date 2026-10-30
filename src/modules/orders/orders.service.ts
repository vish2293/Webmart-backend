import { Types, type ClientSession } from 'mongoose';
import { isStripeConfigured } from '../../integrations/stripe.js';
import { checkCoupon, claimCoupon, type CouponRule } from '../coupons/coupons.service.js';
import { isDuplicateKeyError, withTransaction } from '../../lib/db.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { claimMembershipBenefit, isMembershipActive } from '../memberships/memberships.service.js';
import { notifyOrder } from '../notifications/notifications.service.js';
import { Product } from '../products/product.model.js';
import {
  claimFirstOrderDiscount,
  isFirstOrderEligible,
  spendPoints,
} from '../rewards/rewards.service.js';
import { User } from '../users/user.model.js';
import type { AuthenticatedUser } from '../users/users.types.js';
import { notCancelled, Order, type OrderItemRecord } from './order.model.js';
import {
  estimatedDeliveryDate,
  priceOrder,
  type DeliveryOption,
  type OrderPricing,
} from './order-pricing.js';
import type { CreateOrderInput, QuoteOrderInput } from './orders.validation.js';

/** One line of an INSUFFICIENT_STOCK error, so the client can say exactly what changed. */
type StockShortage = { productId: string; name: string; requested: number; available: number };

/**
 * Thrown when stock can't cover the order — typically because another customer's order took
 * the last units first. Lists every short item so the customer sees all changes at once.
 */
function insufficientStockError(shortages: StockShortage[]) {
  const [only] = shortages;
  const message =
    shortages.length === 1 && only
      ? only.available === 0
        ? `${only.name} just sold out.`
        : `Only ${only.available} of ${only.name} left in stock.`
      : 'Some items in your cart just sold out or are running low.';
  return new ConflictError(message, 'INSUFFICIENT_STOCK', { items: shortages });
}

/** Unpaid, undelivered orders a customer may hold at once; stops stock hoarding. */
const maxOpenOrdersPerUser = 5;

async function buildOrderItems(
  input: CreateOrderInput['orderItems'],
  session?: ClientSession,
): Promise<OrderItemRecord[]> {
  const products = await Product.find({ _id: { $in: input.map((item) => item.product) } })
    .select('name imageUrl price countInStock')
    .session(session ?? null)
    .lean();
  const productsById = new Map(products.map((product) => [product._id.toString(), product]));

  const shortages: StockShortage[] = [];
  const items = input.map((item) => {
    const product = productsById.get(item.product);
    if (!product) {
      throw new ConflictError(
        'An item in your cart is no longer available. Please review your cart.',
        'PRODUCT_UNAVAILABLE',
      );
    }
    if (product.countInStock < item.qty) {
      shortages.push({
        productId: product._id.toString(),
        name: product.name,
        requested: item.qty,
        available: Math.max(product.countInStock, 0),
      });
    }
    return {
      product: product._id,
      name: product.name,
      image: product.imageUrl,
      price: product.price,
      qty: item.qty,
    };
  });
  if (shortages.length > 0) throw insufficientStockError(shortages);
  return items;
}

/** Same lock order in every transaction keeps write conflicts (and driver retries) rare. */
const byProductId = (a: OrderItemRecord, b: OrderItemRecord) =>
  a.product.toString().localeCompare(b.product.toString());

/**
 * Decrements stock inside the caller's transaction. The `$gte` guard makes each decrement
 * conditional, and the transaction makes the whole order all-or-nothing: if any item is short,
 * nothing is reserved. Concurrent checkouts touching the same product conflict and are retried
 * against the fresh stock level, so stock can never go negative.
 */
export async function reserveStock(items: OrderItemRecord[], session: ClientSession) {
  for (const item of [...items].sort(byProductId)) {
    const result = await Product.updateOne(
      { _id: item.product, countInStock: { $gte: item.qty } },
      { $inc: { countInStock: -item.qty } },
      { session },
    );
    if (result.modifiedCount === 0) {
      // Lost the race for this product: report the live level so the customer sees real numbers.
      const current = await Product.findById(item.product)
        .select('countInStock')
        .session(session)
        .lean();
      throw insufficientStockError([
        {
          productId: item.product.toString(),
          name: item.name,
          requested: item.qty,
          available: Math.max(current?.countInStock ?? 0, 0),
        },
      ]);
    }
  }
}

/** Puts reserved stock back, inside the caller's transaction. */
export async function releaseStock(items: OrderItemRecord[], session: ClientSession) {
  for (const item of [...items].sort(byProductId)) {
    // A deleted product simply matches nothing.
    await Product.updateOne(
      { _id: item.product },
      { $inc: { countInStock: item.qty } },
      { session },
    );
  }
}

function assertTotalUnchanged(expectedTotal: number | undefined, actualTotal: number) {
  if (expectedTotal !== undefined && Math.abs(expectedTotal - actualTotal) >= 0.01) {
    throw new ConflictError(
      'Prices have changed since you added these items. Please review your cart.',
      'PRICE_CHANGED',
    );
  }
}

async function assertOpenOrderLimit(userId: string) {
  const openOrders = await Order.countDocuments({
    user: userId,
    isPaid: false,
    isDelivered: false,
    ...notCancelled,
  });
  if (openOrders >= maxOpenOrdersPerUser) {
    throw new ConflictError(
      'You have too many unpaid orders. Complete or wait for them to expire before ordering again.',
      'TOO_MANY_OPEN_ORDERS',
    );
  }
}

function findByIdempotencyKey(userId: string, idempotencyKey: string) {
  return Order.findOne({ user: userId, idempotencyKey }).lean();
}

/**
 * Places an order atomically. With an idempotency key, a retried request (double click,
 * network timeout) returns the order created by the first attempt instead of a duplicate.
 */
export async function createOrder(
  userId: string,
  input: CreateOrderInput,
  idempotencyKey?: string,
) {
  if (idempotencyKey) {
    const existing = await findByIdempotencyKey(userId, idempotencyKey);
    if (existing) return { order: existing, isNew: false };
  }
  // Never create an order that couldn't be paid.
  if (input.paymentMethod === 'Stripe' && !isStripeConfigured) {
    throw new BadRequestError('Stripe payments are not available', 'PAYMENT_METHOD_UNAVAILABLE');
  }
  // ponytail: count runs outside the transaction, so two simultaneous requests can exceed the
  // cap by one. It's an abuse limit, not an invariant.
  await assertOpenOrderLimit(userId);

  try {
    const order = await withTransaction(async (session) => {
      const orderId = new Types.ObjectId();
      const orderItems = await buildOrderItems(input.orderItems, session);
      const { pricing, coupon, couponError } = await priceForUser(
        userId,
        orderItems,
        input.pointsToRedeem,
        input.deliveryOption,
        input.couponCode,
        session,
      );
      // The customer asked for a coupon that no longer works: tell them rather than charging more.
      if (couponError) throw new ConflictError(couponError, 'COUPON_INVALID');
      assertTotalUnchanged(input.totalPrice, pricing.totalPrice);

      // Both claims are guarded writes on the user document: a concurrent checkout by the same
      // customer conflicts here and is retried against the new state.
      if (pricing.firstOrderDiscount > 0 && !(await claimFirstOrderDiscount(userId, session))) {
        throw new ConflictError(
          'Your first-order discount was already used. Please review your order.',
          'PRICE_CHANGED',
        );
      }
      // Counts the order against the membership, which also blocks a refund racing this order.
      if (pricing.memberBenefitsApplied && !(await claimMembershipBenefit(userId, session))) {
        throw new ConflictError(
          'Your Plus membership changed. Please review your order.',
          'PRICE_CHANGED',
        );
      }
      // Takes a use of the coupon; fails if someone else just took the last one.
      if (coupon) await claimCoupon(coupon.id, userId, orderId.toString(), session);
      await spendPoints(userId, orderId.toString(), pricing.pointsRedeemed, session);
      await reserveStock(orderItems, session);

      const [created] = await Order.create(
        [
          {
            _id: orderId,
            user: userId,
            orderItems,
            shippingAddress: input.shippingAddress,
            paymentMethod: input.paymentMethod,
            idempotencyKey,
            deliveryOption: input.deliveryOption,
            estimatedDeliveryDate: estimatedDeliveryDate(input.deliveryOption),
            ...(coupon && { coupon: coupon.id }),
            // `maxRedeemablePoints` is display-only; strict schema mode drops it.
            ...pricing,
          },
        ],
        { session },
      );
      if (!created) throw new Error('Order was not created');
      return created;
    });
    // Online orders are confirmed by email once paid; cash on delivery is confirmed now.
    if (order.paymentMethod === 'Cash on Delivery')
      await notifyOrder(order._id.toString(), 'confirmed');
    return { order, isNew: true };
  } catch (error) {
    // A concurrent retry with the same key committed first.
    if (idempotencyKey && isDuplicateKeyError(error)) {
      const existing = await findByIdempotencyKey(userId, idempotencyKey);
      if (existing) return { order: existing, isNew: false };
    }
    throw error;
  }
}

type PricedOrder = {
  pricing: OrderPricing;
  /** The coupon, when one was entered and applies. */
  coupon?: CouponRule;
  /** Why an entered coupon doesn't apply. Prices are then worked out without it. */
  couponError?: string;
};

/** Prices items with this customer's discount eligibility, coupon and points balance. */
async function priceForUser(
  userId: string,
  orderItems: OrderItemRecord[],
  pointsRequested: number,
  deliveryOption: DeliveryOption,
  couponCode: string | undefined,
  session?: ClientSession,
): Promise<PricedOrder> {
  // Sequential on purpose: one transaction session must not run operations in parallel.
  const isEligible = await isFirstOrderEligible(userId, session);
  const user = await User.findById(userId)
    .select('pointsBalance membershipEndsAt')
    .session(session ?? null)
    .lean();

  let coupon: CouponRule | undefined;
  let couponError: string | undefined;
  if (couponCode) {
    const itemsPrice = orderItems.reduce((sum, item) => sum + item.price * item.qty, 0);
    const check = await checkCoupon(couponCode, userId, itemsPrice, session);
    if (check.ok) coupon = check.rule;
    else couponError = check.message;
  }

  const pricing = priceOrder({
    items: orderItems,
    isFirstOrderEligible: isEligible,
    ...(coupon && { coupon }),
    isMember: isMembershipActive(user?.membershipEndsAt),
    deliveryOption,
    pointsRequested,
    pointsBalance: user?.pointsBalance ?? 0,
  });
  return { pricing, ...(coupon && { coupon }), ...(couponError && { couponError }) };
}

/** What checkout would charge right now; the same numbers `createOrder` will use. */
export async function quoteOrder(
  userId: string,
  input: QuoteOrderInput,
): Promise<OrderPricing & { couponError?: string }> {
  const orderItems = await buildOrderItems(input.orderItems);
  const { pricing, couponError } = await priceForUser(
    userId,
    orderItems,
    input.pointsToRedeem,
    input.deliveryOption,
    input.couponCode,
  );
  // A coupon that doesn't apply doesn't fail the quote: checkout shows the reason beside the field.
  return { ...pricing, ...(couponError && { couponError }) };
}

type PopulatedOrderUser = { _id: Types.ObjectId; name: string; email: string } | null;

export async function getOrderForUser(orderId: string, viewer: AuthenticatedUser) {
  const order = await Order.findById(orderId)
    .populate<{ user: PopulatedOrderUser }>('user', 'name email')
    .populate('orderItems.product', 'name imageUrl')
    .lean();
  if (!order) throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');

  const isOwner = order.user?._id.toString() === viewer.id;
  if (!isOwner && viewer.role !== 'admin') {
    throw new ForbiddenError('Not authorized to view this order', 'ORDER_FORBIDDEN');
  }
  return order;
}

export function listOrdersForUser(userId: string) {
  return Order.find({ user: userId })
    .populate('orderItems.product', 'name imageUrl')
    .sort({ createdAt: -1 })
    .lean();
}

// ponytail: unbounded admin list; sales reports aggregate over the full array client-side.
// Move reports to a server-side aggregation and paginate this when order volume grows.
export function listAllOrders() {
  return Order.find().populate('user', 'name').sort({ createdAt: -1 }).lean();
}
