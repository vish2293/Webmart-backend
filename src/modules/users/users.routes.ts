import { Router } from 'express';
import { authenticateRequest, requireAdmin } from '../../middleware/authenticate.js';
import { authRateLimit } from '../../middleware/rate-limit.js';
import * as usersController from './users.controller.js';

export const usersRouter = Router();

usersRouter.post('/register', authRateLimit, usersController.register);
usersRouter.post('/login', authRateLimit, usersController.login);
usersRouter.post('/forgot-password', authRateLimit, usersController.forgotPassword);
usersRouter.post('/reset-password', authRateLimit, usersController.resetPassword);

usersRouter
  .route('/profile')
  .get(authenticateRequest, usersController.getProfile)
  .put(authenticateRequest, usersController.updateProfile);

usersRouter.use('/addresses', authenticateRequest);
usersRouter.get('/addresses', usersController.listAddresses);
usersRouter.post('/addresses', usersController.addAddress);
usersRouter.put('/addresses/:addressId', usersController.updateAddress);
usersRouter.put('/addresses/:addressId/default', usersController.setDefaultAddress);
usersRouter.delete('/addresses/:addressId', usersController.deleteAddress);

usersRouter.get('/', authenticateRequest, requireAdmin, usersController.listUsers);
usersRouter.delete('/:id', authenticateRequest, requireAdmin, usersController.deleteUser);
