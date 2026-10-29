import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { BadGatewayError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const apiBaseUrl = 'https://api.razorpay.com/v1';
const requestTimeoutMs = 10_000;

const razorpayOrderSchema = z.object({
  id: z.string(),
  amount: z.number(),
  currency: z.string(),
});

const razorpayPaymentsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      amount: z.number(),
      email: z.string().nullish(),
    }),
  ),
});

export type RazorpayOrder = z.infer<typeof razorpayOrderSchema>;
export type RazorpayPayment = z.infer<typeof razorpayPaymentsSchema>['items'][number];

async function razorpayRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  init: { method: 'GET' | 'POST'; body?: unknown; failureMessage: string },
): Promise<T> {
  const credentials = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString(
    'base64',
  );

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method: init.method,
      headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    throw new BadGatewayError('Payment gateway is unreachable', 'PAYMENT_GATEWAY_ERROR', {
      cause: error,
    });
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // Razorpay error bodies contain a code and description, never credentials.
    logger.error({ path, status: response.status, body }, 'Razorpay request failed');
    throw new BadGatewayError(init.failureMessage, 'PAYMENT_GATEWAY_ERROR');
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    logger.error({ path, body }, 'Unexpected Razorpay response');
    throw new BadGatewayError(init.failureMessage, 'PAYMENT_GATEWAY_ERROR');
  }
  return parsed.data;
}

/**
 * Creates a Razorpay order. Not retried: a retry after a timeout could create a second
 * gateway order. An orphaned unpaid Razorpay order is harmless.
 */
export function createRazorpayOrder(input: {
  amountInPaise: number;
  receipt: string;
  notes: Record<string, string>;
}): Promise<RazorpayOrder> {
  return razorpayRequest('/orders', razorpayOrderSchema, {
    method: 'POST',
    body: {
      amount: input.amountInPaise,
      currency: 'INR',
      receipt: input.receipt,
      notes: input.notes,
    },
    failureMessage: 'Could not start payment',
  });
}

/** All payment attempts made against a Razorpay order. Read-only, safe to retry. */
export async function fetchRazorpayOrderPayments(
  razorpayOrderId: string,
): Promise<RazorpayPayment[]> {
  const result = await razorpayRequest(
    `/orders/${encodeURIComponent(razorpayOrderId)}/payments`,
    razorpayPaymentsSchema,
    { method: 'GET', failureMessage: 'Could not check payment status' },
  );
  return result.items;
}

function hmacSha256Hex(secret: string, payload: string | Buffer) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function isSameSignature(expected: string, received: string) {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

/** Verifies the signature Razorpay Checkout returns to the browser after a successful payment. */
export function isValidPaymentSignature(input: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  signature: string;
}) {
  const expected = hmacSha256Hex(
    env.RAZORPAY_KEY_SECRET,
    `${input.razorpayOrderId}|${input.razorpayPaymentId}`,
  );
  return isSameSignature(expected, input.signature);
}

/** Verifies `X-Razorpay-Signature` against the exact raw request body. */
export function isValidWebhookSignature(rawBody: Buffer, signature: string) {
  return isSameSignature(hmacSha256Hex(env.RAZORPAY_WEBHOOK_SECRET, rawBody), signature);
}
