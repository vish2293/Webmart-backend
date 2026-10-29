import type { Request, Response } from 'express';
import { idParamsSchema } from '../../lib/validation.js';
import { getAuthenticatedUser } from '../../middleware/authenticate.js';
import * as productsService from './products.service.js';
import {
  listProductsQuerySchema,
  productInputSchema,
  productUpdateSchema,
  suggestProductsQuerySchema,
} from './products.validation.js';

export async function listProducts(req: Request, res: Response) {
  res.json(await productsService.listProducts(listProductsQuerySchema.parse(req.query)));
}

export async function suggestProducts(req: Request, res: Response) {
  const { q } = suggestProductsQuerySchema.parse(req.query);
  res.json(await productsService.suggestProducts(q));
}

export async function getProduct(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  res.json(await productsService.getProduct(id));
}

export async function createProduct(req: Request, res: Response) {
  const input = productInputSchema.parse(req.body);
  const product = await productsService.createProduct(getAuthenticatedUser(req).id, input);
  res.status(201).json(product);
}

export async function updateProduct(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  res.json(await productsService.updateProduct(id, productUpdateSchema.parse(req.body)));
}

export async function deleteProduct(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  await productsService.deleteProduct(id);
  res.json({ message: 'Product removed' });
}
