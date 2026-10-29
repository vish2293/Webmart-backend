import { Router } from 'express';
import { authenticateRequest } from '../../middleware/authenticate.js';
import * as rewardsController from './rewards.controller.js';

export const rewardsRouter = Router();

rewardsRouter.get('/me', authenticateRequest, rewardsController.getMyRewards);
