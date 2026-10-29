import { z } from 'zod';
import { objectIdSchema } from '../../lib/validation.js';

export const paymentMethods = ['UPI', 'Card', 'Cash on Delivery'] as const;
export type PaymentMethod = (typeof paymentMethods)[number];

const addressLine = (max: number) => z.string().trim().min(1).max(max);

/** `Idempotency-Key` header: one per checkout attempt, reused when retrying that attempt. */
export const idempotencyKeySchema = z
  .string()
  .regex(/^[\w-]{16,64}$/, 'Idempotency-Key must be 16-64 letters, digits, - or _')
  .optional();

// Client-sent prices, names and images are ignored (unknown keys are stripped);
// the server reads them from the product catalogue. `totalPrice` is only compared against
// the server's total, so the customer is never charged an amount they weren't shown.
export const createOrderSchema = z.object({
  totalPrice: z.number().nonnegative().optional(),
  orderItems: z
    .array(
      z.object({
        product: objectIdSchema,
        qty: z.number().int().min(1).max(100),
      }),
    )
    .min(1, 'No order items')
    .max(50)
    .refine((items) => new Set(items.map((item) => item.product)).size === items.length, {
      message: 'Each product may appear only once per order',
    }),
  shippingAddress: z.object({
    address: addressLine(200),
    city: addressLine(100),
    postalCode: addressLine(20),
    country: addressLine(100),
  }),
  paymentMethod: z.enum(paymentMethods),
});

const paymentField = z.string().trim().max(200).optional();

export const markPaidSchema = z
  .object({
    id: paymentField,
    status: paymentField,
    update_time: paymentField,
    email_address: paymentField,
  })
  .default({});

const razorpayId = z.string().trim().min(1).max(100);

/** Field names match what Razorpay Checkout passes to its success handler. */
export const verifyRazorpayPaymentSchema = z.object({
  razorpay_order_id: razorpayId,
  razorpay_payment_id: razorpayId,
  razorpay_signature: z.string().trim().min(1).max(256),
});

/** Only the fields we use; Razorpay events carry much more. */
export const razorpayWebhookEventSchema = z.object({
  event: z.string(),
  payload: z.object({
    payment: z
      .object({
        entity: z.object({
          id: z.string(),
          order_id: z.string().nullable(),
          amount: z.number(),
          email: z.string().nullish(),
        }),
      })
      .optional(),
  }),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type MarkPaidInput = z.infer<typeof markPaidSchema>;
export type VerifyRazorpayPaymentInput = z.infer<typeof verifyRazorpayPaymentSchema>;
export type RazorpayWebhookEvent = z.infer<typeof razorpayWebhookEventSchema>;
