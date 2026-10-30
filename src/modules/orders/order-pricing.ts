import type { CouponRule } from '../coupons/coupons.service.js';
import { membershipRules } from '../memberships/memberships.config.js';
import { rewardRules } from '../rewards/rewards.config.js';

export const deliveryOptions = ['standard', 'express'] as const;
export type DeliveryOption = (typeof deliveryOptions)[number];

// Must stay in sync with client/src/features/cart/utils/pricing.ts, which shows pre-discount
// totals in the cart. Checkout shows the server's quote; the server's numbers get charged.
export const pricingRules = {
  taxRate: 0.08,
  flatShippingPrice: 10,
  freeShippingThreshold: 100,
  /** Extra charge for express delivery; Plus members don't pay it. */
  expressDeliveryPrice: 49,
  /** Promised delivery windows, in days from the order. */
  standardDeliveryDays: 7,
  expressDeliveryDays: 2,
} as const;

export type OrderPricing = {
  itemsPrice: number;
  shippingPrice: number;
  expressDeliveryPrice: number;
  /** Shipping and express fees waived by Plus on this order. */
  memberSavings: number;
  memberBenefitsApplied: boolean;
  pointsMultiplier: number;
  firstOrderDiscount: number;
  /** Coupon applied to this order, and the rupees it took off. */
  couponCode?: string;
  couponDiscount: number;
  pointsRedeemed: number;
  pointsDiscount: number;
  /** Most points usable on this order with the customer's balance (for display). */
  maxRedeemablePoints: number;
  taxPrice: number;
  totalPrice: number;
};

export type PriceOrderInput = {
  items: { price: number; qty: number }[];
  isFirstOrderEligible: boolean;
  /** A coupon that already passed its eligibility checks; this only works out its amount. */
  coupon?: CouponRule;
  isMember: boolean;
  deliveryOption: DeliveryOption;
  pointsRequested: number;
  pointsBalance: number;
};

const roundMoney = (amount: number) => Math.round(amount * 100) / 100;

/** Razorpay amounts are integers in the smallest currency unit. */
export const toPaise = (amountInRupees: number) => Math.round(amountInRupees * 100);

/** Rupees a coupon takes off an amount: a percentage (up to its cap) or a flat sum, never below 0. */
function couponAmount(coupon: CouponRule, amount: number) {
  const raw =
    coupon.type === 'percent'
      ? Math.min((amount * coupon.value) / 100, coupon.maxDiscount ?? Number.POSITIVE_INFINITY)
      : coupon.value;
  return Math.max(0, Math.min(raw, amount));
}

/**
 * The single source of order totals: used by the checkout quote and by order creation, so the
 * amount shown is always the amount charged.
 */
export function priceOrder(input: PriceOrderInput): OrderPricing {
  const itemsPrice = roundMoney(input.items.reduce((sum, item) => sum + item.price * item.qty, 0));
  // Based on the pre-discount price, so a discount never makes shipping suddenly apply.
  const standardShipping =
    itemsPrice === 0 || itemsPrice > pricingRules.freeShippingThreshold
      ? 0
      : pricingRules.flatShippingPrice;
  const standardExpressFee =
    input.deliveryOption === 'express' ? pricingRules.expressDeliveryPrice : 0;
  const shippingPrice = input.isMember ? 0 : standardShipping;
  const expressDeliveryPrice = input.isMember ? 0 : standardExpressFee;
  const memberSavings = input.isMember ? roundMoney(standardShipping + standardExpressFee) : 0;

  const firstOrderDiscount = input.isFirstOrderEligible
    ? roundMoney(
        Math.min(
          itemsPrice * rewardRules.firstOrderDiscountRate,
          rewardRules.firstOrderDiscountCap,
        ),
      )
    : 0;

  const afterFirstOrder = itemsPrice - firstOrderDiscount;
  // Applied after the first-order discount and never more than what's left of the items price.
  const couponDiscount = input.coupon ? roundMoney(couponAmount(input.coupon, afterFirstOrder)) : 0;
  const afterCoupon = afterFirstOrder - couponDiscount;
  const maxRedeemablePoints = Math.max(
    0,
    Math.min(
      Math.floor((afterCoupon * rewardRules.maxRedeemShare) / rewardRules.rupeesPerPointSpent),
      Math.floor(input.pointsBalance),
    ),
  );
  const pointsRedeemed = Math.min(
    Math.max(0, Math.floor(input.pointsRequested)),
    maxRedeemablePoints,
  );
  const pointsDiscount = roundMoney(pointsRedeemed * rewardRules.rupeesPerPointSpent);

  // Discounts reduce the taxable amount.
  const taxableAmount = roundMoney(afterCoupon - pointsDiscount);
  const taxPrice = roundMoney(taxableAmount * pricingRules.taxRate);

  return {
    itemsPrice,
    shippingPrice,
    expressDeliveryPrice,
    memberSavings,
    memberBenefitsApplied: input.isMember,
    pointsMultiplier: input.isMember ? membershipRules.pointsMultiplier : 1,
    firstOrderDiscount,
    ...(input.coupon && { couponCode: input.coupon.code }),
    couponDiscount,
    pointsRedeemed,
    pointsDiscount,
    maxRedeemablePoints,
    taxPrice,
    totalPrice: roundMoney(taxableAmount + shippingPrice + expressDeliveryPrice + taxPrice),
  };
}

export const pointsEarnedFor = (totalPrice: number, multiplier = 1) =>
  Math.floor((totalPrice / rewardRules.rupeesPerPointEarned) * multiplier);

export const estimatedDeliveryDate = (option: DeliveryOption, from = new Date()) =>
  new Date(
    from.getTime() +
      (option === 'express'
        ? pricingRules.expressDeliveryDays
        : pricingRules.standardDeliveryDays) *
        24 *
        60 *
        60_000,
  );
