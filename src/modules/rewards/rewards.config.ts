// Discount and points rules. The client's policy text restates these numbers; keep them in sync
// with client/src/features/policies/content.ts.
export const rewardRules = {
  /** New customers get this share of the items price off their first order... */
  firstOrderDiscountRate: 0.1,
  /** ...capped at this many rupees. */
  firstOrderDiscountCap: 200,
  /** One point is earned per this many rupees of an order's total. */
  rupeesPerPointEarned: 100,
  /** Value of one point when spent. */
  rupeesPerPointSpent: 1,
  /** Points can cover at most this share of (items − first-order discount). */
  maxRedeemShare: 0.2,
} as const;
