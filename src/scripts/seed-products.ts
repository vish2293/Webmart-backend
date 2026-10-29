/**
 * Seeds the catalogue with sample products. Safe to re-run: products are matched by name and
 * only inserted when missing, so admin edits (price, stock) are never overwritten.
 *
 * Products must reference an admin. If none exists, one is created with SEED_ADMIN_EMAIL
 * (default admin@webmart.com) and a random password that is printed once.
 *
 *   npm run seed:products
 */
import { randomBytes } from 'node:crypto';
import { connectDatabase, disconnectDatabase } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { Product } from '../modules/products/product.model.js';
import { User } from '../modules/users/user.model.js';
import { seedProducts } from './seed-products.data.js';

async function findOrCreateAdmin() {
  const admin = await User.findOne({ role: 'admin' }).select('_id email').lean();
  if (admin) return admin._id;

  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@webmart.com';
  const password = randomBytes(12).toString('base64url');
  const created = await User.create({ name: 'Store Admin', email, password, role: 'admin' });

  // Printed to stdout (not the logger) so it isn't shipped to log storage.
  console.log(`\nCreated admin account — save this now, it won't be shown again:`);
  console.log(`  email:    ${email}\n  password: ${password}\n`);
  return created._id;
}

async function seed() {
  await connectDatabase();
  try {
    const adminId = await findOrCreateAdmin();
    const result = await Product.bulkWrite(
      seedProducts.map((product) => ({
        updateOne: {
          filter: { name: product.name },
          update: { $setOnInsert: { ...product, user: adminId } },
          upsert: true,
        },
      })),
    );
    logger.info(
      {
        inserted: result.upsertedCount,
        alreadyPresent: seedProducts.length - result.upsertedCount,
      },
      'Product seed complete',
    );
  } finally {
    await disconnectDatabase();
  }
}

seed().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Product seed failed');
  process.exitCode = 1;
});
