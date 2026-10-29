import type { Request, Response } from 'express';
import { idParamsSchema } from '../../lib/validation.js';
import { getAuthenticatedUser } from '../../middleware/authenticate.js';
import * as addressesService from './addresses.service.js';
import * as usersService from './users.service.js';
import {
  addressInputSchema,
  addressParamsSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  updateProfileSchema,
} from './users.validation.js';

export async function register(req: Request, res: Response) {
  const session = await usersService.registerUser(registerSchema.parse(req.body));
  res.status(201).json(session);
}

export async function login(req: Request, res: Response) {
  res.json(await usersService.loginUser(loginSchema.parse(req.body)));
}

export async function forgotPassword(req: Request, res: Response) {
  await usersService.requestPasswordReset(forgotPasswordSchema.parse(req.body));
  // Same answer whether or not the email has an account.
  res.json({ message: 'If that email has an account, a reset link is on its way.' });
}

export async function resetPassword(req: Request, res: Response) {
  res.json(await usersService.resetPassword(resetPasswordSchema.parse(req.body)));
}

export async function listAddresses(req: Request, res: Response) {
  res.json(await addressesService.listAddresses(getAuthenticatedUser(req).id));
}

export async function addAddress(req: Request, res: Response) {
  const input = addressInputSchema.parse(req.body);
  res.status(201).json(await addressesService.addAddress(getAuthenticatedUser(req).id, input));
}

export async function updateAddress(req: Request, res: Response) {
  const { addressId } = addressParamsSchema.parse(req.params);
  const input = addressInputSchema.parse(req.body);
  res.json(await addressesService.updateAddress(getAuthenticatedUser(req).id, addressId, input));
}

export async function setDefaultAddress(req: Request, res: Response) {
  const { addressId } = addressParamsSchema.parse(req.params);
  res.json(await addressesService.setDefaultAddress(getAuthenticatedUser(req).id, addressId));
}

export async function deleteAddress(req: Request, res: Response) {
  const { addressId } = addressParamsSchema.parse(req.params);
  res.json(await addressesService.deleteAddress(getAuthenticatedUser(req).id, addressId));
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
