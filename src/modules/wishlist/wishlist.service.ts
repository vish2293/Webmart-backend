import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { Product } from '../products/product.model.js';
import { User } from '../users/user.model.js';

/** Plenty for a wishlist, and keeps the user document small. */
export const maxWishlistItems = 100;

/** The customer's saved products, most recently added first. Deleted products drop out. */
export async function getWishlist(userId: string) {
  const user = await User.findById(userId).select('wishlist').lean();
  if (!user) throw new NotFoundError('User not found', 'USER_NOT_FOUND');
  const ids = user.wishlist ?? [];
  if (ids.length === 0) return [];

  const products = await Product.find({ _id: { $in: ids } }).lean();
  const byId = new Map(products.map((product) => [product._id.toString(), product]));
  return [...ids].reverse().flatMap((id) => {
    const product = byId.get(id.toString());
    return product ? [product] : [];
  });
}

/** Adding something already saved is a no-op, so double taps and retries are safe. */
export async function addToWishlist(userId: string, productId: string) {
  if (!(await Product.exists({ _id: productId }))) {
    throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
  }
  const user = await User.findById(userId).select('wishlist').lean();
  if (!user) throw new NotFoundError('User not found', 'USER_NOT_FOUND');
  const saved = user.wishlist ?? [];

  if (!saved.some((id) => id.toString() === productId)) {
    if (saved.length >= maxWishlistItems) {
      throw new ConflictError(
        `Your wishlist is full (${maxWishlistItems} items). Remove something to add more.`,
        'WISHLIST_FULL',
      );
    }
    // $addToSet keeps it unique even if two requests race.
    await User.updateOne({ _id: userId }, { $addToSet: { wishlist: productId } });
  }
  return getWishlist(userId);
}

export async function removeFromWishlist(userId: string, productId: string) {
  await User.updateOne({ _id: userId }, { $pull: { wishlist: productId } });
  return getWishlist(userId);
}
