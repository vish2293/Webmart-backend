import { Router } from 'express';
import { authenticateRequest } from '../../middleware/authenticate.js';
import { perUserRateLimit } from '../../middleware/rate-limit.js';
import * as reviewsController from './reviews.controller.js';

const writeRateLimit = perUserRateLimit(10);

/** Mounted at /products/:productId/reviews, hence `mergeParams`. */
export const reviewsRouter = Router({ mergeParams: true });

reviewsRouter.get('/', reviewsController.listReviews);
reviewsRouter.get('/mine', authenticateRequest, reviewsController.getMyReview);
reviewsRouter.put('/mine', authenticateRequest, writeRateLimit, reviewsController.saveReview);
reviewsRouter.delete(
  '/:reviewId',
  authenticateRequest,
  writeRateLimit,
  reviewsController.deleteReview,
);
