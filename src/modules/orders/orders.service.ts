import { Types, type ClientSession } from 'mongoose';
import { isDuplicateKeyError, withTransaction } from '../../lib/db.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { Product } from '../products/product.model.js';
import {
  claimFirstOrderDiscount,
  isFirstOrderEligible,
  spendPoints,
} from '../rewards/rewards.service.js';
import { User } from '../users/user.model.js';
import type { AuthenticatedUser } from '../users/users.types.js';
import { notCancelled, Order, type OrderItemRecord } from './order.model.js';
import { priceOrder, type OrderPricing } from './order-pricing.js';
import type { CreateOrderInput, QuoteOrderInput } from './orders.validation.js';

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

  return input.map((item) => {
    const product = productsById.get(item.product);
    if (!product) {
      throw new ConflictError(
        'An item in your cart is no longer available. Please review your cart.',
        'PRODUCT_UNAVAILABLE',
      );
    }
    if (product.countInStock < item.qty) {
      throw new ConflictError(
        product.countInStock === 0
          ? `${product.name} is out of stock`
          : `Only ${product.countInStock} of ${product.name} left in stock`,
        'INSUFFICIENT_STOCK',
      );
    }
    return {
      product: product._id,
      name: product.name,
      image: product.imageUrl,
      price: product.price,
      qty: item.qty,
    };
  });
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
      throw new ConflictError(`Not enough stock for ${item.name}`, 'INSUFFICIENT_STOCK');
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
  // ponytail: count runs outside the transaction, so two simultaneous requests can exceed the
  // cap by one. It's an abuse limit, not an invariant.
  await assertOpenOrderLimit(userId);

  try {
    const order = await withTransaction(async (session) => {
      const orderId = new Types.ObjectId();
      const orderItems = await buildOrderItems(input.orderItems, session);
      const pricing = await priceForUser(userId, orderItems, input.pointsToRedeem, session);
      assertTotalUnchanged(input.totalPrice, pricing.totalPrice);

      // Both claims are guarded writes on the user document: a concurrent checkout by the same
      // customer conflicts here and is retried against the new state.
      if (pricing.firstOrderDiscount > 0 && !(await claimFirstOrderDiscount(userId, session))) {
        throw new ConflictError(
          'Your first-order discount was already used. Please review your order.',
          'PRICE_CHANGED',
        );
      }
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
            // `maxRedeemablePoints` is display-only; strict schema mode drops it.
            ...pricing,
          },
        ],
        { session },
      );
      return created;
    });
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

/** Prices items with this customer's discount eligibility and points balance. */
async function priceForUser(
  userId: string,
  orderItems: OrderItemRecord[],
  pointsRequested: number,
  session?: ClientSession,
): Promise<OrderPricing> {
  const [isEligible, user] = await Promise.all([
    isFirstOrderEligible(userId, session),
    User.findById(userId)
      .select('pointsBalance')
      .session(session ?? null)
      .lean(),
  ]);
  return priceOrder({
    items: orderItems,
    isFirstOrderEligible: isEligible,
    pointsRequested,
    pointsBalance: user?.pointsBalance ?? 0,
  });
}

/** What checkout would charge right now; the same numbers `createOrder` will use. */
export async function quoteOrder(userId: string, input: QuoteOrderInput): Promise<OrderPricing> {
  const orderItems = await buildOrderItems(input.orderItems);
  return priceForUser(userId, orderItems, input.pointsToRedeem);
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
