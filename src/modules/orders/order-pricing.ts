import { rewardRules } from '../rewards/rewards.config.js';

// Must stay in sync with client/src/features/cart/utils/pricing.ts, which shows pre-discount
// totals in the cart. Checkout shows the server's quote; the server's numbers get charged.
export const pricingRules = {
  taxRate: 0.08,
  flatShippingPrice: 10,
  freeShippingThreshold: 100,
} as const;

export type OrderPricing = {
  itemsPrice: number;
  shippingPrice: number;
  firstOrderDiscount: number;
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
  pointsRequested: number;
  pointsBalance: number;
};

const roundMoney = (amount: number) => Math.round(amount * 100) / 100;

/** Razorpay amounts are integers in the smallest currency unit. */
export const toPaise = (amountInRupees: number) => Math.round(amountInRupees * 100);

/**
 * The single source of order totals: used by the checkout quote and by order creation, so the
 * amount shown is always the amount charged.
 */
export function priceOrder(input: PriceOrderInput): OrderPricing {
  const itemsPrice = roundMoney(input.items.reduce((sum, item) => sum + item.price * item.qty, 0));
  // Based on the pre-discount price, so a discount never makes shipping suddenly apply.
  const shippingPrice =
    itemsPrice === 0 || itemsPrice > pricingRules.freeShippingThreshold
      ? 0
      : pricingRules.flatShippingPrice;

  const firstOrderDiscount = input.isFirstOrderEligible
    ? roundMoney(
        Math.min(
          itemsPrice * rewardRules.firstOrderDiscountRate,
          rewardRules.firstOrderDiscountCap,
        ),
      )
    : 0;

  const afterFirstOrder = itemsPrice - firstOrderDiscount;
  const maxRedeemablePoints = Math.max(
    0,
    Math.min(
      Math.floor((afterFirstOrder * rewardRules.maxRedeemShare) / rewardRules.rupeesPerPointSpent),
      Math.floor(input.pointsBalance),
    ),
  );
  const pointsRedeemed = Math.min(
    Math.max(0, Math.floor(input.pointsRequested)),
    maxRedeemablePoints,
  );
  const pointsDiscount = roundMoney(pointsRedeemed * rewardRules.rupeesPerPointSpent);

  // Discounts reduce the taxable amount.
  const taxableAmount = roundMoney(afterFirstOrder - pointsDiscount);
  const taxPrice = roundMoney(taxableAmount * pricingRules.taxRate);

  return {
    itemsPrice,
    shippingPrice,
    firstOrderDiscount,
    pointsRedeemed,
    pointsDiscount,
    maxRedeemablePoints,
    taxPrice,
    totalPrice: roundMoney(taxableAmount + shippingPrice + taxPrice),
  };
}

export const pointsEarnedFor = (totalPrice: number) =>
  Math.floor(totalPrice / rewardRules.rupeesPerPointEarned);
