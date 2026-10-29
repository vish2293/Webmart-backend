import type { Request, Response } from 'express';
import { idParamsSchema } from '../../lib/validation.js';
import { getAuthenticatedUser } from '../../middleware/authenticate.js';
import * as usersService from './users.service.js';
import { loginSchema, registerSchema, updateProfileSchema } from './users.validation.js';

export async function register(req: Request, res: Response) {
  const session = await usersService.registerUser(registerSchema.parse(req.body));
  res.status(201).json(session);
}

export async function login(req: Request, res: Response) {
  res.json(await usersService.loginUser(loginSchema.parse(req.body)));
}

export async function getProfile(req: Request, res: Response) {
  res.json(await usersService.getProfile(getAuthenticatedUser(req).id));
}

export async function updateProfile(req: Request, res: Response) {
  const input = updateProfileSchema.parse(req.body);
  res.json(await usersService.updateProfile(getAuthenticatedUser(req).id, input));
}

export async function listUsers(_req: Request, res: Response) {
  res.json(await usersService.listUsers());
}

export async function deleteUser(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  await usersService.deleteUser(getAuthenticatedUser(req).id, id);
  res.json({ message: 'User removed' });
}
