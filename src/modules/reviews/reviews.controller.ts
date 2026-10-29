import type { Request, Response } from 'express';
import { getAuthenticatedUser } from '../../middleware/authenticate.js';
import * as reviewsService from './reviews.service.js';
import {
  listReviewsQuerySchema,
  reviewInputSchema,
  reviewParamsSchema,
  reviewProductParamsSchema,
} from './reviews.validation.js';

export async function listReviews(req: Request, res: Response) {
  const { productId } = reviewProductParamsSchema.parse(req.params);
  res.json(await reviewsService.listReviews(productId, listReviewsQuerySchema.parse(req.query)));
}

export async function getMyReview(req: Request, res: Response) {
  const { productId } = reviewProductParamsSchema.parse(req.params);
  res.json(await reviewsService.getMyReviewState(getAuthenticatedUser(req).id, productId));
}

export async function saveReview(req: Request, res: Response) {
  const { productId } = reviewProductParamsSchema.parse(req.params);
  const input = reviewInputSchema.parse(req.body);
  res.json(await reviewsService.saveReview(getAuthenticatedUser(req).id, productId, input));
}

export async function deleteReview(req: Request, res: Response) {
  const { productId, reviewId } = reviewParamsSchema.parse(req.params);
  await reviewsService.deleteReview(getAuthenticatedUser(req), productId, reviewId);
  res.json({ message: 'Review removed' });
}
