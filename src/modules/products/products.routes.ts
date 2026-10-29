import { Router } from 'express';
import { authenticateRequest, requireAdmin } from '../../middleware/authenticate.js';
import * as productsController from './products.controller.js';

export const productsRouter = Router();

productsRouter.get('/', productsController.listProducts);
productsRouter.get('/:id', productsController.getProduct);

productsRouter.post('/admin', authenticateRequest, requireAdmin, productsController.createProduct);
productsRouter
  .route('/admin/:id')
  .put(authenticateRequest, requireAdmin, productsController.updateProduct)
  .delete(authenticateRequest, requireAdmin, productsController.deleteProduct);
