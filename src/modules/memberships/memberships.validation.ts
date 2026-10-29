import { z } from 'zod';
import { membershipPlanIds } from './memberships.config.js';

export const checkoutMembershipSchema = z.object({ plan: z.enum(membershipPlanIds) });
