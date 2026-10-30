import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import {
  createCheckoutSession,
  createStripeCustomer,
  expireCheckoutSession,
  retrieveCheckoutSession,
  toGatewayRefundStatus,
  type StripeCheckoutSession,
  type StripeEvent,
} from '../../integrations/stripe.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { User } from '../users/user.model.js';
import type { AuthenticatedUser } from '../users/users.types.js';
import { Order } from './order.model.js';
import {
  findPayableOrder,
  latePaymentRefundedCodes,
  recordOnlinePayment,
} from './order-payment-core.js';
import { toPaise } from './order-pricing.js';
import { applyRefundWebhook } from './order-refunds.service.js';

/** Stripe's minimum lifetime for a Checkout Session. */
const sessionLifetimeSeconds = 30 * 60;

/**
 * One Stripe Customer per user, created on their first Stripe payment and reused afterwards.
 * The idempotency key means two simultaneous first payments still create a single customer.
 */
async function ensureStripeCustomer(payer: AuthenticatedUser) {
  const user = await User.findById(payer.id).select('+stripeCustomerId name email').lean();
  if (!user) throw new NotFoundError('User not found', 'USER_NOT_FOUND');
  if (user.stripeCustomerId) return user.stripeCustomerId;

  const customer = await createStripeCustomer(
    { userId: payer.id, name: user.name, email: user.email },
    `webmart-customer-${payer.id}`,
  );
  await User.updateOne(
    { _id: payer.id, stripeCustomerId: { $exists: false } },
    { stripeCustomerId: customer.id },
  );
  const stored = await User.findById(payer.id).select('+stripeCustomerId').lean();
  return stored?.stripeCustomerId ?? customer.id;
}

const toCheckout = (session: StripeCheckoutSession & { url: string }) => ({
  url: session.url,
  expiresAt: new Date(session.expires_at * 1000).toISOString(),
});

/**
 * Creates (or reuses) the hosted Stripe Checkout page for an order and returns where to send the
 * customer. The amount comes from the order in our database, never from the browser. Calling it
 * again while a session is still open returns that same page, so double clicks and retries can't
 * create two payable sessions.
 */
export async function startStripePayment(orderId: string, payer: AuthenticatedUser) {
  const order = await findPayableOrder(orderId, payer);
  if (order.isPaid) throw new ConflictError('Order is already paid', 'ORDER_ALREADY_PAID');
  if (order.isCancelled) {
    throw new ConflictError(
      'This order expired because it was not paid in time. Please place a new order.',
      'ORDER_CANCELLED',
    );
  }
  if (order.paymentMethod !== 'Stripe') {
    throw new BadRequestError('This order is not paid with Stripe', 'PAYMENT_METHOD_MISMATCH');
  }

  const previousSessionId = order.stripeCheckoutSessionId;
  if (previousSessionId) {
    const existing = await retrieveCheckoutSession(previousSessionId);
    if (existing.status === 'complete') {
      if (existing.payment_status === 'paid') {
        await applyCheckoutSession(existing);
        throw new ConflictError('Order is already paid', 'ORDER_ALREADY_PAID');
      }
      throw new ConflictError(
        'A payment for this order is being processed. Please wait a moment and refresh.',
        'PAYMENT_IN_PROGRESS',
      );
    }
    if (existing.status === 'open' && existing.url) {
      return toCheckout({ ...existing, url: existing.url });
    }
    // Expired: fall through and create a fresh session.
  }

  const customer = await ensureStripeCustomer(payer);
  const orderUrl = `${env.CLIENT_URL}/orders/${orderId}`;
  const session = await createCheckoutSession(
    {
      mode: 'payment',
      customer,
      client_reference_id: orderId,
      metadata: { orderId },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'inr',
            unit_amount: toPaise(order.totalPrice),
            product_data: { name: `WebMart order #${orderId.slice(-8)}` },
          },
        },
      ],
      payment_intent_data: {
        metadata: { orderId },
        description: `WebMart order #${orderId.slice(-8)}`,
      },
      // Stripe accounts in India must collect the customer's address for card payments.
      billing_address_collection: 'required',
      expires_at: Math.floor(Date.now() / 1000) + sessionLifetimeSeconds,
      // Fixed URLs built from our own config: nothing the browser sends can redirect the customer.
      success_url: `${orderUrl}?stripe=success`,
      cancel_url: `${orderUrl}?stripe=cancelled`,
    },
    // Same order + same previous session = same request, so a concurrent duplicate gets this one.
    `webmart-checkout-${orderId}-${previousSessionId ?? 'first'}`,
  );
  if (!session.url) {
    throw new ConflictError('Could not start payment. Please try again.', 'PAYMENT_GATEWAY_ERROR');
  }

  const saved = await Order.findOneAndUpdate(
    { _id: orderId, stripeCheckoutSessionId: previousSessionId ?? { $exists: false } },
    { stripeCheckoutSessionId: session.id },
    { new: true },
  )
    .select('stripeCheckoutSessionId')
    .lean();
  if (!saved) {
    // A concurrent request attached its session first; make sure only one stays payable.
    const winnerId = (await Order.findById(orderId).select('stripeCheckoutSessionId').lean())
      ?.stripeCheckoutSessionId;
    if (winnerId && winnerId !== session.id) {
      await expireCheckoutSession(session.id);
      const winner = await retrieveCheckoutSession(winnerId);
      if (winner.status === 'open' && winner.url) return toCheckout({ ...winner, url: winner.url });
    }
  }
  logger.info({ orderId, sessionId: session.id }, 'Stripe checkout session created');
  return toCheckout({ ...session, url: session.url });
}

type SessionOutcome = 'recorded' | 'pending' | 'ignored';

/**
 * Turns a paid Checkout Session into a paid order. Used by the webhook and by the browser's
 * return-trip check, so whichever arrives first wins and the other is a harmless no-op
 * (`recordOnlinePayment` is idempotent per payment).
 */
async function applyCheckoutSession(session: StripeCheckoutSession): Promise<SessionOutcome> {
  if (session.payment_status !== 'paid') return 'pending';

  const orderId = session.metadata?.orderId;
  if (!orderId || !Types.ObjectId.isValid(orderId)) {
    logger.warn({ sessionId: session.id }, 'Stripe session without a valid order id');
    return 'ignored';
  }
  const order = await Order.findById(orderId).select('totalPrice').lean();
  if (!order) {
    logger.warn({ sessionId: session.id, orderId }, 'Stripe session for unknown order');
    return 'ignored';
  }

  const expected = toPaise(order.totalPrice);
  if (session.amount_total !== expected || session.currency !== 'inr') {
    logger.error(
      { orderId, sessionId: session.id, paid: session.amount_total, expected },
      'Stripe payment amount does not match order total',
    );
    return 'ignored';
  }

  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;
  if (!paymentIntentId) {
    logger.error({ orderId, sessionId: session.id }, 'Paid Stripe session without a PaymentIntent');
    return 'ignored';
  }

  await recordOnlinePayment(orderId, {
    id: paymentIntentId,
    email: session.customer_details?.email ?? undefined,
    method: session.payment_method_types?.[0],
  });
  return 'recorded';
}

/**
 * The browser's check after returning from Stripe: asks Stripe directly (using the session we
 * stored, not anything the browser sends) so the order page is right even before the webhook lands.
 */
export async function syncStripePayment(orderId: string, payer: AuthenticatedUser) {
  const order = await findPayableOrder(orderId, payer);
  if (!order.isPaid) {
    if (!order.stripeCheckoutSessionId) {
      throw new BadRequestError(
        'No Stripe payment was started for this order',
        'PAYMENT_NOT_STARTED',
      );
    }
    const session = await retrieveCheckoutSession(order.stripeCheckoutSessionId);
    const outcome = await applyCheckoutSession(session);
    if (outcome === 'pending') {
      throw new ConflictError(
        session.status === 'complete'
          ? 'Payment received. We are confirming it with the bank; this page will update shortly.'
          : 'The payment was not completed, so nothing was charged.',
        session.status === 'complete' ? 'PAYMENT_PENDING' : 'PAYMENT_NOT_COMPLETED',
      );
    }
    if (outcome === 'ignored') {
      throw new ConflictError(
        'We could not confirm this payment automatically. If you were charged, contact support.',
        'PAYMENT_NOT_CONFIRMED',
      );
    }
  }
  const fresh = await Order.findById(orderId).lean();
  if (!fresh) throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
  return fresh;
}

/** What is left of an order's Stripe payment once its Checkout Session can no longer change. */
export type StripeSettlement = 'paid' | 'pending' | 'closed';

/**
 * Before cancelling an unpaid order (expiry, switch to cash): close the Checkout Session so it
 * can't be paid afterwards, and notice if it was paid in the meantime.
 */
export async function settleStripeCheckout(sessionId: string): Promise<StripeSettlement> {
  let session = await retrieveCheckoutSession(sessionId);
  if (session.status === 'open') {
    await expireCheckoutSession(sessionId);
    // If expiring failed the customer just paid; re-reading shows which way it went.
    session = await retrieveCheckoutSession(sessionId);
  }
  if (session.status !== 'complete') return 'closed';
  if (session.payment_status !== 'paid') return 'pending';
  return (await applyCheckoutSession(session)) === 'recorded' ? 'paid' : 'pending';
}

/** Best effort when a customer or admin cancels: the unpaid Stripe page must stop working. */
export async function closeStripeCheckoutForOrder(orderId: string) {
  try {
    const order = await Order.findById(orderId)
      .select('stripeCheckoutSessionId isPaid paymentMethod')
      .lean();
    if (!order?.stripeCheckoutSessionId || order.isPaid) return;
    await expireCheckoutSession(order.stripeCheckoutSessionId);
  } catch (error) {
    // The cancel already succeeded; a payment on the stale page would be refunded as late.
    logger.warn({ err: error, orderId }, 'Could not close the Stripe checkout page');
  }
}

/** Signature must already be verified. Unknown or irrelevant events are acknowledged and ignored. */
export async function handleStripeEvent(event: StripeEvent) {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      try {
        const outcome = await applyCheckoutSession(event.data.object);
        if (outcome === 'pending') {
          logger.info({ sessionId: event.data.object.id }, 'Stripe payment still processing');
        }
      } catch (error) {
        // Already logged and refunded; retrying the webhook can't change the outcome.
        if (error instanceof ConflictError && latePaymentRefundedCodes.has(error.code)) return;
        throw error;
      }
      return;

    case 'checkout.session.async_payment_failed':
      logger.warn({ sessionId: event.data.object.id }, 'Stripe delayed payment failed');
      return;

    case 'checkout.session.expired':
      logger.info({ sessionId: event.data.object.id }, 'Stripe checkout session expired');
      return;

    case 'refund.updated':
    case 'refund.failed': {
      const refund = event.data.object;
      const paymentIntentId =
        typeof refund.payment_intent === 'string'
          ? refund.payment_intent
          : refund.payment_intent?.id;
      const status = toGatewayRefundStatus(refund.status);
      if (!paymentIntentId || status === 'pending') return;
      await applyRefundWebhook(
        { id: refund.id, payment_id: paymentIntentId },
        status === 'processed' ? 'refund.processed' : 'refund.failed',
      );
      return;
    }

    case 'charge.dispute.created':
      // A chargeback needs a human to answer it in the Stripe dashboard before the deadline.
      logger.error(
        {
          disputeId: event.data.object.id,
          amount: event.data.object.amount,
          reason: event.data.object.reason,
          paymentIntent: event.data.object.payment_intent,
        },
        'Stripe dispute opened; respond in the Stripe dashboard',
      );
      return;

    default:
      return;
  }
}
