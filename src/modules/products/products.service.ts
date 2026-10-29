import type { FilterQuery, SortOrder } from 'mongoose';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { Product, type ProductRecord } from './product.model.js';
import type { ListProductsQuery, ProductInput, ProductUpdateInput } from './products.validation.js';

const sortByOption: Record<ListProductsQuery['sortBy'], Record<string, SortOrder>> = {
  newest: { createdAt: -1 },
  'price-asc': { price: 1 },
  'price-desc': { price: -1 },
};

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function listProducts(query: ListProductsQuery) {
  const filter: FilterQuery<ProductRecord> = {};
  if (query.keyword) filter.name = { $regex: escapeRegex(query.keyword), $options: 'i' };
  if (query.category && query.category !== 'All') filter.category = query.category;

  const [products, count] = await Promise.all([
    Product.find(filter)
      .sort(sortByOption[query.sortBy])
      .skip(query.limit * (query.pageNumber - 1))
      .limit(query.limit)
      .lean(),
    Product.countDocuments(filter),
  ]);

  return { products, page: query.pageNumber, pages: Math.ceil(count / query.limit) };
}

export async function getProduct(productId: string) {
  const product = await Product.findById(productId).lean();
  if (!product) throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
  return product;
}

export function createProduct(adminId: string, input: ProductInput) {
  return Product.create({ ...input, user: adminId });
}

/** Optimistic concurrency: only applies if nobody (admin or checkout) changed it since load. */
export async function updateProduct(
  productId: string,
  { updatedAt, ...input }: ProductUpdateInput,
) {
  const product = await Product.findOneAndUpdate(
    { _id: productId, updatedAt: new Date(updatedAt) },
    input,
    { new: true, runValidators: true },
  ).lean();
  if (product) return product;

  if (!(await Product.exists({ _id: productId }))) {
    throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
  }
  throw new ConflictError(
    'This product changed since you opened it (for example, a sale updated its stock). Reload it and try again.',
    'PRODUCT_MODIFIED',
  );
}

export async function deleteProduct(productId: string) {
  const deleted = await Product.findByIdAndDelete(productId).select('_id').lean();
  if (!deleted) throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
}
