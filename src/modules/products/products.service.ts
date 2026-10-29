import type { FilterQuery, SortOrder } from 'mongoose';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { Product, type ProductRecord } from './product.model.js';
import {
  buildSearchFilter,
  correctSpelling,
  scoreProduct,
  tokenize,
  vocabularyFrom,
  wordsOf,
} from './products.search.js';
import type { ListProductsQuery, ProductInput, ProductUpdateInput } from './products.validation.js';

const sortByOption: Record<ListProductsQuery['sortBy'], Record<string, SortOrder>> = {
  newest: { createdAt: -1 },
  'price-asc': { price: 1 },
  'price-desc': { price: -1 },
};

/** Most matches ranked in memory; beyond this the best ones are what a shopper sees anyway. */
const maxRankedMatches = 500;
const suggestionCount = 6;
const vocabularyTtlMs = 60_000;

let vocabularyCache: { words: string[]; loadedAt: number } | undefined;

async function loadVocabulary() {
  if (vocabularyCache && Date.now() - vocabularyCache.loadedAt < vocabularyTtlMs) {
    return vocabularyCache.words;
  }
  const words = vocabularyFrom(await Product.find().select('name category').lean());
  vocabularyCache = { words, loadedAt: Date.now() };
  return words;
}

export async function listProducts(query: ListProductsQuery) {
  const filter: FilterQuery<ProductRecord> = {};
  const tokens = query.keyword ? tokenize(query.keyword) : [];
  if (tokens.length > 0) Object.assign(filter, buildSearchFilter(tokens));
  if (query.category && query.category !== 'All') filter.category = query.category;

  // With a search phrase, the default ordering ("newest" in the API) means best match first.
  // ponytail: ranked in memory over at most `maxRankedMatches` rows; move to Atlas Search when
  // the catalogue outgrows a few thousand products.
  if (query.keyword && tokens.length > 0 && query.sortBy === 'newest') {
    const keyword = query.keyword;
    const matches = await Product.find(filter).limit(maxRankedMatches).lean();
    const ranked = matches
      .map((product) => ({ product, score: scoreProduct(product, tokens, keyword) }))
      .sort((a, b) => b.score - a.score)
      .map(({ product }) => product);
    const start = query.limit * (query.pageNumber - 1);
    return {
      products: ranked.slice(start, start + query.limit),
      page: query.pageNumber,
      pages: Math.ceil(ranked.length / query.limit),
    };
  }

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

/** Search-box suggestions, plus a corrected phrase ("did you mean") when nothing matches. */
export async function suggestProducts(keyword: string) {
  const tokens = tokenize(keyword);
  if (tokens.length === 0) return { suggestions: [] };

  const matches = await Product.find(buildSearchFilter(tokens))
    .select('name category price imageUrl description rating countInStock')
    .limit(60)
    .lean();
  if (matches.length > 0) {
    const suggestions = matches
      .map((product) => ({ product, score: scoreProduct(product, tokens, keyword) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, suggestionCount)
      .map(({ product }) => ({
        _id: product._id,
        name: product.name,
        category: product.category,
        price: product.price,
        imageUrl: product.imageUrl,
      }));
    return { suggestions };
  }

  const corrected = correctSpelling(wordsOf(keyword), await loadVocabulary());
  if (!corrected) return { suggestions: [] };
  // Only offer a correction that actually finds something.
  const hasResults = await Product.exists(buildSearchFilter(corrected));
  return { suggestions: [], didYouMean: hasResults ? corrected.join(' ') : undefined };
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
