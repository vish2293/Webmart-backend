// Must stay in sync with client/src/features/cart/utils/pricing.ts, which shows the same totals
// before checkout. The server's numbers are the ones that get charged.
export const pricingRules = {
  taxRate: 0.08,
  flatShippingPrice: 10,
  freeShippingThreshold: 100,
} as const;

export type OrderPricing = {
  itemsPrice: number;
  shippingPrice: number;
  taxPrice: number;
  totalPrice: number;
};

const roundMoney = (amount: number) => Math.round(amount * 100) / 100;

/** Razorpay amounts are integers in the smallest currency unit. */
export const toPaise = (amountInRupees: number) => Math.round(amountInRupees * 100);

export function calculateOrderPricing(items: { price: number; qty: number }[]): OrderPricing {
  const itemsPrice = roundMoney(items.reduce((sum, item) => sum + item.price * item.qty, 0));
  const shippingPrice =
    itemsPrice === 0 || itemsPrice > pricingRules.freeShippingThreshold
      ? 0
      : pricingRules.flatShippingPrice;
  const taxPrice = roundMoney(itemsPrice * pricingRules.taxRate);

  return {
    itemsPrice,
    shippingPrice,
    taxPrice,
    totalPrice: roundMoney(itemsPrice + shippingPrice + taxPrice),
  };
}
