import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { objectIdSchema } from '../../lib/validation.js';
import { authenticateRequest, getAuthenticatedUser } from '../../middleware/authenticate.js';
import { perUserRateLimit } from '../../middleware/rate-limit.js';
import * as wishlistService from './wishlist.service.js';

const productParamsSchema = z.object({ productId: objectIdSchema });
const writeRateLimit = perUserRateLimit(60);

export const wishlistRouter = Router();

wishlistRouter.use(authenticateRequest);

wishlistRouter.get('/', async (req: Request, res: Response) => {
  res.json(await wishlistService.getWishlist(getAuthenticatedUser(req).id));
});

// Both return the whole updated list, so the client can replace its copy.
wishlistRouter.put('/:productId', writeRateLimit, async (req: Request, res: Response) => {
  const { productId } = productParamsSchema.parse(req.params);
  res.json(await wishlistService.addToWishlist(getAuthenticatedUser(req).id, productId));
});

wishlistRouter.delete('/:productId', writeRateLimit, async (req: Request, res: Response) => {
  const { productId } = productParamsSchema.parse(req.params);
  res.json(await wishlistService.removeFromWishlist(getAuthenticatedUser(req).id, productId));
});
