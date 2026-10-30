import Stripe from 'stripe';
import { env } from '../config/env.js';
import { AppError, BadGatewayError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const requestTimeoutMs = 10_000;

export const isStripeConfigured = Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);

let client: Stripe | undefined;

/** One shared client; the SDK pins its own API version, so Stripe changes can't alter behaviour. */
function getStripe() {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    throw new AppError(
      503,
      'STRIPE_UNAVAILABLE',
      'Stripe payments are not available right now. Please choose another payment method.',
    );
  }
  client ??= new Stripe(env.STRIPE_SECRET_KEY, {
    timeout: requestTimeoutMs,
    // Safe retries only: the SDK reuses the idempotency key we pass for writes.
    maxNetworkRetries: 2,
    appInfo: { name: 'webmart-server' },
  });
  return client;
}

/**
 * Runs a Stripe call and turns any SDK failure into a generic gateway error. Stripe's message and
 * request id go to the log, never to the customer, and the secret key is never part of an error.
 */
async function stripeCall<T>(failureMessage: string, call: (stripe: Stripe) => Promise<T>) {
  const stripe = getStripe();
  try {
    return await call(stripe);
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error(
      {
        type: error instanceof Stripe.errors.StripeError ? error.type : undefined,
        code: error instanceof Stripe.errors.StripeError ? error.code : undefined,
        requestId: error instanceof Stripe.errors.StripeError ? error.requestId : undefined,
        message: error instanceof Error ? error.message : undefined,
      },
      'Stripe request failed',
    );
    throw new BadGatewayError(failureMessage, 'PAYMENT_GATEWAY_ERROR', { cause: error });
  }
}

export type StripeCheckoutSession = Stripe.Checkout.Session;
export type StripeEvent = Stripe.Event;

/** One Stripe Customer per user: reused for every payment so the dashboard shows their history. */
export function createStripeCustomer(
  input: { userId: string; name: string; email: string },
  idempotencyKey: string,
) {
  return stripeCall('Could not start payment', (stripe) =>
    stripe.customers.create(
      { name: input.name, email: input.email, metadata: { userId: input.userId } },
      { idempotencyKey },
    ),
  );
}

export function createCheckoutSession(
  params: Stripe.Checkout.SessionCreateParams,
  idempotencyKey: string,
) {
  return stripeCall('Could not start payment', (stripe) =>
    stripe.checkout.sessions.create(params, { idempotencyKey }),
  );
}

export function retrieveCheckoutSession(sessionId: string) {
  return stripeCall('Could not check payment status', (stripe) =>
    stripe.checkout.sessions.retrieve(sessionId),
  );
}

/**
 * Closes an unpaid Checkout Session so it can no longer be paid. Returns false if Stripe refused,
 * normally because the customer completed it a moment ago; callers re-read the session then.
 */
export async function expireCheckoutSession(sessionId: string) {
  try {
    await getStripe().checkout.sessions.expire(sessionId);
    return true;
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.info({ sessionId }, 'Stripe checkout session could not be expired');
    return false;
  }
}

/** Refund states mapped onto the ones orders store ('processed' | 'failed' | 'pending'). */
const refundStatus = (status: string | null): 'processed' | 'failed' | 'pending' =>
  status === 'succeeded'
    ? 'processed'
    : status === 'failed' || status === 'canceled'
      ? 'failed'
      : 'pending';

export type GatewayRefund = { id: string; status: 'processed' | 'failed' | 'pending' };

/** A refund already made for this PaymentIntent that hasn't failed, if any. Read-only. */
export async function findStripeRefund(paymentIntentId: string): Promise<GatewayRefund | null> {
  const refunds = await stripeCall('Could not check refund status', (stripe) =>
    stripe.refunds.list({ payment_intent: paymentIntentId, limit: 10 }),
  );
  const existing = refunds.data.find((refund) => refundStatus(refund.status) !== 'failed');
  return existing ? { id: existing.id, status: refundStatus(existing.status) } : null;
}

/**
 * Refunds a PaymentIntent. The idempotency key makes a repeat of the same refund (retry after a
 * timeout, two servers) return the first one instead of refunding twice.
 */
export async function createStripeRefund(input: {
  paymentIntentId: string;
  amountInPaise: number;
  orderId: string;
  reason: string;
}): Promise<GatewayRefund> {
  const refund = await stripeCall('Could not refund payment', (stripe) =>
    stripe.refunds.create(
      {
        payment_intent: input.paymentIntentId,
        amount: input.amountInPaise,
        metadata: { orderId: input.orderId, reason: input.reason },
      },
      { idempotencyKey: `webmart-refund-${input.paymentIntentId}` },
    ),
  );
  return { id: refund.id, status: refundStatus(refund.status) };
}

export const toGatewayRefundStatus = refundStatus;

/**
 * Verifies `Stripe-Signature` against the exact raw body (HMAC with a timestamp tolerance, so an
 * old captured request can't be replayed) and returns the parsed event. Throws if invalid.
 */
export function constructWebhookEvent(rawBody: Buffer, signature: string): StripeEvent {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new AppError(503, 'STRIPE_UNAVAILABLE', 'Stripe webhooks are not configured');
  }
  // Static helper: needs no API key, only the signing secret.
  return Stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
}
