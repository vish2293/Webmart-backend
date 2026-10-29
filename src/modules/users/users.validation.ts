import { z } from 'zod';

const minPasswordLength = 6;
const maxPasswordLength = 128;

const nameSchema = z.string().trim().min(1, 'Name is required').max(100);
const emailSchema = z.string().trim().max(254).pipe(z.email('Invalid email address'));
// bcrypt ignores everything after 72 bytes, so longer passwords would silently match shorter ones.
const bcryptMaxBytes = 72;

const newPasswordSchema = z
  .string()
  .min(minPasswordLength, `Password must be at least ${minPasswordLength} characters`)
  .refine((password) => Buffer.byteLength(password, 'utf8') <= bcryptMaxBytes, {
    message: 'Password is too long (maximum 72 characters)',
  });

export const registerSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: newPasswordSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(maxPasswordLength),
});

export const updateProfileSchema = z.object({
  name: nameSchema.optional(),
  email: emailSchema.optional(),
  // The client sends an empty string when the password is unchanged.
  password: z.union([z.literal(''), newPasswordSchema]).optional(),
});

const addressLine = (max: number) => z.string().trim().min(1).max(max);

export const addressInputSchema = z.object({
  label: addressLine(30).default('Home'),
  address: addressLine(200),
  city: addressLine(100),
  postalCode: addressLine(20),
  country: addressLine(100),
  isDefault: z.boolean().default(false),
});

export const addressParamsSchema = z.object({ addressId: z.string().regex(/^[a-f\d]{24}$/i) });

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/, 'Invalid reset link'),
  password: newPasswordSchema,
});

export type AddressInput = z.infer<typeof addressInputSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
