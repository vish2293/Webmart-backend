// Plus membership rules. The client's Plus page and policy text restate these numbers; keep them
// in sync with client/src/features/membership/config.ts and client/src/features/policies/content.ts.
export const membershipPlans = {
  monthly: { label: 'Plus Monthly', price: 199, durationDays: 30 },
  yearly: { label: 'Plus Yearly', price: 1499, durationDays: 365 },
} as const;

export type MembershipPlanId = keyof typeof membershipPlans;
export const membershipPlanIds = Object.keys(membershipPlans) as [
  MembershipPlanId,
  ...MembershipPlanId[],
];

export const membershipRules = {
  /** Points credited once when a membership is bought. */
  welcomeBonusPoints: 100,
  /** Members earn this many times the usual points on every order. */
  pointsMultiplier: 2,
  /** Cancelling for a full refund is allowed this long after payment, if no order used the benefits. */
  refundWindowDays: 7,
  /** Buying again is allowed once the current membership has this few days left. */
  renewalWindowDays: 7,
} as const;

export const dayMs = 24 * 60 * 60_000;
