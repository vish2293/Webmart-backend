/**
 * Makes the database's indexes match the ones declared in the models: builds the missing ones and
 * drops any the models no longer declare (e.g. a single-field index replaced by a compound one).
 * Mongoose already creates missing indexes when the server starts; this is for the "drop" half and
 * for building them deliberately, before a deploy, instead of during startup on a big collection.
 *
 *   npm run db:sync-indexes
 */
import { connectDatabase, disconnectDatabase } from '../lib/db.js';
import { Coupon, CouponRedemption, CouponUsage } from '../modules/coupons/coupon.model.js';
import { Membership } from '../modules/memberships/membership.model.js';
import { Order } from '../modules/orders/order.model.js';
import { StripeEvent } from '../modules/orders/stripe-event.model.js';
import { Product } from '../modules/products/product.model.js';
import { PointsTransaction } from '../modules/rewards/points-transaction.model.js';
import { Review } from '../modules/reviews/review.model.js';
import { User } from '../modules/users/user.model.js';

const models = [
  User,
  Product,
  Order,
  Review,
  PointsTransaction,
  Membership,
  StripeEvent,
  Coupon,
  CouponRedemption,
  CouponUsage,
];

async function run() {
  await connectDatabase();
  try {
    for (const model of models) {
      const dropped = await model.syncIndexes();
      console.log(
        `${model.collection.name}: ${dropped.length > 0 ? `dropped ${dropped.join(', ')}` : 'ok'}`,
      );
    }
  } finally {
    await disconnectDatabase();
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
