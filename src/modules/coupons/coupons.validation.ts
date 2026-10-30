import { z } from 'zod';
import { couponTypes } from './coupon.model.js';

/** What a customer types: letters, digits, - and _, case-insensitive. */
export const couponCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_-]{3,32}$/, 'Coupon codes use 3-32 letters, digits, - or _');

const optionalDate = z.iso.datetime({ offset: true }).optional();

const couponFields = {
  description: z.string().trim().max(200).optional(),
  value: z.number().positive().max(1_000_000),
  maxDiscount: z.number().positive().max(1_000_000).optional(),
  minOrderValue: z.number().min(0).max(10_000_000).default(0),
  startsAt: optionalDate,
  expiresAt: optionalDate,
  usageLimit: z.number().int().min(1).max(10_000_000).optional(),
  perUserLimit: z.number().int().min(1).max(1000).default(1),
  isActive: z.boolean().default(true),
};

const checkRanges = (
  coupon: { type?: string; value?: number; startsAt?: string; expiresAt?: string },
  ctx: z.RefinementCtx,
) => {
  if (coupon.type === 'percent' && coupon.value !== undefined && coupon.value > 100) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'A percentage can be at most 100' });
  }
  if (coupon.startsAt && coupon.expiresAt && coupon.expiresAt <= coupon.startsAt) {
    ctx.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'Expiry must be after the start',
    });
  }
};

export const createCouponSchema = z
  .object({ code: couponCodeSchema, type: z.enum(couponTypes), ...couponFields })
  .superRefine(checkRanges);

/** Everything but the code and type can change; value and limits only matter going forward. */
export const updateCouponSchema = z
  .object({
    description: couponFields.description,
    value: couponFields.value.optional(),
    maxDiscount: couponFields.maxDiscount.nullable().optional(),
    minOrderValue: couponFields.minOrderValue.optional(),
    startsAt: optionalDate.nullable(),
    expiresAt: optionalDate.nullable(),
    usageLimit: couponFields.usageLimit.nullable().optional(),
    perUserLimit: couponFields.perUserLimit.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type CreateCouponInput = z.infer<typeof createCouponSchema>;
export type UpdateCouponInput = z.infer<typeof updateCouponSchema>;
