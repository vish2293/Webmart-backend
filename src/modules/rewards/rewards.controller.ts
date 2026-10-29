import type { Request, Response } from 'express';
import { getAuthenticatedUser } from '../../middleware/authenticate.js';
import * as rewardsService from './rewards.service.js';

export async function getMyRewards(req: Request, res: Response) {
  res.json(await rewardsService.getRewardsSummary(getAuthenticatedUser(req).id));
}
