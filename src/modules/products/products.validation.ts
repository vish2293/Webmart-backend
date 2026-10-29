import { z } from 'zod';

export const maxProductPageSize = 100;

export const productSortOptions = ['newest', 'price-asc', 'price-desc'] as const;

export const listProductsQuerySchema = z.object({
  keyword: z.string().trim().max(100).optional(),
  category: z.string().trim().max(100).optional(),
  sortBy: z.enum(productSortOptions).default('newest'),
  pageNumber: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(maxProductPageSize).default(maxProductPageSize),
});

export const productInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000),
  price: z.number().nonnegative().max(10_000_000),
  imageUrl: z.url({ protocol: /^https?$/ }).max(2048),
  category: z.string().trim().min(1).max(100),
  countInStock: z.number().int().nonnegative().max(1_000_000),
});

/**
 * `updatedAt` is the version the admin's form was loaded from. Without it, saving a form opened
 * before a sale would write back the old `countInStock` and undo the sale's stock decrement.
 */
export const productUpdateSchema = productInputSchema.extend({
  updatedAt: z.iso.datetime({ offset: true }),
});

export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
export type ProductInput = z.infer<typeof productInputSchema>;
export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;
