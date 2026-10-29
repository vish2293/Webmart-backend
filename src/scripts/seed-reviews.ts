/**
 * Adds SAMPLE reviews to the catalogue so the reviews UI has something to show in development.
 * They are real review records (the product's average and count are rebuilt from them), but are
 * flagged `isDemo`, written by clearly fake "demo" accounts, and shown on the site as
 * "Sample review". Safe to re-run: existing sample reviews are left alone.
 *
 *   npm run seed:reviews              add sample reviews
 *   npm run seed:reviews -- --remove  delete them and the demo accounts again
 *
 * Refuses to run in production: sample reviews on a live store would mislead customers.
 */
import { randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../lib/db.js';
import { Product } from '../modules/products/product.model.js';
import { Review } from '../modules/reviews/review.model.js';
import { recomputeProductRating } from '../modules/reviews/reviews.service.js';
import { User } from '../modules/users/user.model.js';

const demoEmailSuffix = '@demo.invalid';
const reviewers = [
  'Aarav Sharma',
  'Priya Menon',
  'Rohan Kulkarni',
  'Neha Patel',
  'Vikram Thakur',
  'Ananya Iyer',
  'Karan Malhotra',
];

// Generic on purpose: they must read sensibly under any product.
const comments: Record<'high' | 'mid' | 'low', { title: string; comment: string }[]> = {
  high: [
    {
      title: 'Worth the money',
      comment: 'Good quality for the price. Arrived on time and well packed.',
    },
    { title: 'Happy with it', comment: 'Exactly as described. I would buy from this store again.' },
    { title: 'Very good', comment: 'Looks and feels better than I expected. Quick delivery too.' },
    {
      title: 'Recommended',
      comment: 'Using it daily for a few weeks now and no complaints at all.',
    },
    { title: 'Great buy', comment: 'Packaging was neat and the product matches the photos.' },
  ],
  mid: [
    { title: 'Decent', comment: 'Does the job. Not perfect, but fair for what it costs.' },
    { title: 'Okay overall', comment: 'Good enough, though a few small things could be better.' },
    { title: 'Average', comment: 'As described. Delivery was fine, quality is just average.' },
  ],
  low: [
    {
      title: 'Could be better',
      comment: 'Expected a bit more at this price. Support was helpful though.',
    },
  ],
};

/** Small deterministic generator, so re-running produces the same reviews for a product. */
function seededRandom(seed: string) {
  let state = 0;
  for (const char of seed) state = (state * 31 + char.charCodeAt(0)) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const pick = <T>(items: T[], random: () => number) =>
  items[Math.floor(random() * items.length)] as T;

async function findOrCreateDemoUsers() {
  const ids: string[] = [];
  for (const [index, name] of reviewers.entries()) {
    const email = `demo-reviewer-${index + 1}${demoEmailSuffix}`;
    const existing = await User.findOne({ email }).select('_id').lean();
    // Nobody can log in as these accounts: the password is random and never shown.
    const user =
      existing ??
      (await User.create({ name, email, password: randomBytes(18).toString('base64url') }));
    ids.push(user._id.toString());
  }
  return ids;
}

async function addSampleReviews() {
  const userIds = await findOrCreateDemoUsers();
  const products = await Product.find().select('_id name').lean();
  let added = 0;

  for (const product of products) {
    const random = seededRandom(product.name);
    const count = 2 + Math.floor(random() * 4); // 2 to 5
    const authors = [...userIds].sort(() => random() - 0.5).slice(0, count);

    for (const userId of authors) {
      const roll = random();
      const rating = roll < 0.55 ? 5 : roll < 0.85 ? 4 : roll < 0.95 ? 3 : 2;
      const bucket = rating >= 4 ? 'high' : rating === 3 ? 'mid' : 'low';
      const text = pick(comments[bucket], random);
      const createdAt = new Date(Date.now() - Math.floor(random() * 60 * 86_400_000));

      const result = await Review.updateOne(
        { product: product._id, user: userId },
        {
          $setOnInsert: {
            rating,
            title: text.title,
            comment: text.comment,
            isDemo: true,
            createdAt,
            updatedAt: createdAt,
          },
        },
        { upsert: true, timestamps: false },
      );
      added += result.upsertedCount;
    }
    await recomputeProductRating(product._id.toString());
  }
  console.log(`Added ${added} sample reviews across ${products.length} products.`);
}

async function removeSampleReviews() {
  const affected = await Review.distinct('product', { isDemo: true });
  const reviews = await Review.deleteMany({ isDemo: true });
  const users = await User.deleteMany({ email: { $regex: `${demoEmailSuffix}$` } });
  for (const productId of affected) await recomputeProductRating(productId.toString());
  console.log(
    `Removed ${reviews.deletedCount} sample reviews and ${users.deletedCount} demo accounts.`,
  );
}

async function run() {
  if (env.NODE_ENV === 'production') {
    console.error('Refusing to run in production: sample reviews would mislead real customers.');
    process.exit(1);
  }
  await connectDatabase();
  try {
    if (process.argv.includes('--remove')) await removeSampleReviews();
    else await addSampleReviews();
  } finally {
    await disconnectDatabase();
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
