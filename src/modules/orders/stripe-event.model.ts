import { model, Schema } from 'mongoose';

export interface StripeEventRecord {
  /** The Stripe event id (`evt_…`); being the _id makes a second insert fail. */
  _id: string;
  type: string;
  processedAt: Date;
}

const stripeEventSchema = new Schema<StripeEventRecord>({
  _id: { type: String, required: true },
  type: { type: String, required: true },
  processedAt: { type: Date, required: true, default: Date.now },
});

// Stripe stops retrying an event after 3 days; keep the record for a month, then let it go.
stripeEventSchema.index({ processedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

/** Events whose handling finished, so a redelivery is acknowledged without being replayed. */
export const StripeEvent = model<StripeEventRecord>('StripeEvent', stripeEventSchema);
