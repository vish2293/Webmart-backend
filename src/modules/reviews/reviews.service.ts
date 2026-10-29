import { Types } from 'mongoose';
import { isDuplicateKeyError } from '../../lib/db.js';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { notCancelled, Order } from '../orders/order.model.js';
import { Product } from '../products/product.model.js';
import type { AuthenticatedUser } from '../users/users.types.js';
import { Review } from './review.model.js';
import type { ListReviewsQuery, ReviewInput } from './reviews.validation.js';

/** "Asha Rao" → "Asha R."; reviews show a first name only. */
function displayName(fullName: string | undefined) {
  const [first = 'Customer', second] = (fullName ?? '').trim().split(/\s+/);
  return second ? `${first} ${second.charAt(0).toUpperCase()}.` : first;
}

async function assertProductExists(productId: string) {
  if (!(await Product.exists({ _id: productId }))) {
    throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
  }
}

/** Only customers who actually received the product (and kept it) can review it. */
function hasReceivedProduct(userId: string, productId: string) {
  return Order.exists({
    user: userId,
    isDelivered: true,
    ...notCancelled,
    refundedAt: { $exists: false },
    'orderItems.product': productId,
  });
}

/** Rebuilds the product's average and count from its reviews, so they always match them. */
async function recomputeProductRating(productId: string) {
  const [stats] = await Review.aggregate<{ average: number; count: number }>([
    { $match: { product: new Types.ObjectId(productId) } },
    { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  // `timestamps: false` keeps `updatedAt` as it was, which admin edits and checkout compare.
  await Product.updateOne(
    { _id: productId },
    {
      $set: {
        rating: stats ? Math.round(stats.average * 10) / 10 : 0,
        reviews: stats?.count ?? 0,
      },
    },
    { timestamps: false },
  );
}

export async function listReviews(productId: string, query: ListReviewsQuery) {
  await assertProductExists(productId);
  const filter = { product: productId };

  const [reviews, count, distributionRows] = await Promise.all([
    Review.find(filter)
      .populate<{ user: { name: string } | null }>('user', 'name')
      .sort({ createdAt: -1 })
      .skip(query.limit * (query.pageNumber - 1))
      .limit(query.limit)
      .lean(),
    Review.countDocuments(filter),
    Review.aggregate<{ _id: number; count: number }>([
      { $match: { product: new Types.ObjectId(productId) } },
      { $group: { _id: '$rating', count: { $sum: 1 } } },
    ]),
  ]);

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<number, number>;
  for (const row of distributionRows) distribution[row._id] = row.count;

  return {
    reviews: reviews.map((review) => ({
      _id: review._id.toString(),
      rating: review.rating,
      title: review.title,
      comment: review.comment,
      authorName: displayName(review.user?.name),
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
    })),
    page: query.pageNumber,
    pages: Math.ceil(count / query.limit),
    count,
    distribution,
  };
}

/** What the signed-in customer may do on this product's reviews. */
export async function getMyReviewState(userId: string, productId: string) {
  await assertProductExists(productId);
  const [review, canReview] = await Promise.all([
    Review.findOne({ product: productId, user: userId }).lean(),
    hasReceivedProduct(userId, productId),
  ]);
  return {
    canReview: Boolean(review) || Boolean(canReview),
    review: review
      ? {
          _id: review._id.toString(),
          rating: review.rating,
          title: review.title,
          comment: review.comment,
        }
      : null,
  };
}

/** Creates the customer's review, or replaces it if they already wrote one. */
export async function saveReview(userId: string, productId: string, input: ReviewInput) {
  await assertProductExists(productId);
  const existing = await Review.exists({ product: productId, user: userId });
  if (!existing && !(await hasReceivedProduct(userId, productId))) {
    throw new ForbiddenError(
      'You can review a product after it has been delivered to you.',
      'REVIEW_NOT_ALLOWED',
    );
  }

  // Fields left blank on an edit are removed rather than kept from the earlier version.
  const set: Record<string, unknown> = { rating: input.rating };
  const unset: Record<string, 1> = {};
  for (const field of ['title', 'comment'] as const) {
    if (input[field]) set[field] = input[field];
    else unset[field] = 1;
  }
  const update = { $set: set, ...(Object.keys(unset).length > 0 && { $unset: unset }) };
  const filter = { product: productId, user: userId };
  try {
    await Review.findOneAndUpdate(filter, update, { upsert: true, new: true });
  } catch (error) {
    // Two first-time saves raced; the other one inserted, so this one is just an update.
    if (!isDuplicateKeyError(error)) throw error;
    await Review.findOneAndUpdate(filter, update);
  }
  await recomputeProductRating(productId);
  return getMyReviewState(userId, productId);
}

/** The author can remove their own review; admins can remove any. */
export async function deleteReview(actor: AuthenticatedUser, productId: string, reviewId: string) {
  const review = await Review.findOne({ _id: reviewId, product: productId }).lean();
  if (!review) throw new NotFoundError('Review not found', 'REVIEW_NOT_FOUND');
  if (review.user.toString() !== actor.id && actor.role !== 'admin') {
    throw new ForbiddenError('You can only delete your own review', 'REVIEW_FORBIDDEN');
  }
  await Review.deleteOne({ _id: reviewId });
  await recomputeProductRating(productId);
}
