import { z } from 'zod';
import { objectIdSchema } from '../../lib/validation.js';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => value || undefined);

export const reviewInputSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: optionalText(100),
  comment: optionalText(2000),
});

export const reviewProductParamsSchema = z.object({ productId: objectIdSchema });

export const reviewParamsSchema = reviewProductParamsSchema.extend({ reviewId: objectIdSchema });

export const listReviewsQuerySchema = z.object({
  pageNumber: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export type ReviewInput = z.infer<typeof reviewInputSchema>;
export type ListReviewsQuery = z.infer<typeof listReviewsQuerySchema>;
