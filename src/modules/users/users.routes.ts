import { Router } from 'express';
import { authenticateRequest, requireAdmin } from '../../middleware/authenticate.js';
import { authRateLimit } from '../../middleware/rate-limit.js';
import * as usersController from './users.controller.js';

export const usersRouter = Router();

usersRouter.post('/register', authRateLimit, usersController.register);
usersRouter.post('/login', authRateLimit, usersController.login);

usersRouter
  .route('/profile')
  .get(authenticateRequest, usersController.getProfile)
  .put(authenticateRequest, usersController.updateProfile);

usersRouter.get('/', authenticateRequest, requireAdmin, usersController.listUsers);
usersRouter.delete('/:id', authenticateRequest, requireAdmin, usersController.deleteUser);
