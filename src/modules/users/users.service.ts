import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { sendEmail } from '../../integrations/email.js';
import { passwordResetEmail, storeUrl } from '../../lib/email-templates.js';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from '../../lib/errors.js';
import { signAccessToken, type VerifiedToken } from './token.js';
import { User, type UserRecord } from './user.model.js';
import type {
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  UpdateProfileInput,
} from './users.validation.js';
import type { AuthenticatedUser, PublicUser, UserSession } from './users.types.js';

type UserFields = Pick<UserRecord, '_id' | 'name' | 'email' | 'role'>;

function toPublicUser(user: UserFields): PublicUser {
  return { _id: user._id.toString(), name: user.name, email: user.email, role: user.role };
}

function toSession(user: UserFields): UserSession {
  return { ...toPublicUser(user), token: signAccessToken(user._id.toString()) };
}

export async function findAuthenticatedUser(token: VerifiedToken): Promise<AuthenticatedUser> {
  const user = await User.findById(token.userId).select('name email role passwordChangedAt').lean();
  if (!user) throw new UnauthorizedError('Not authorized, user not found', 'AUTH_USER_NOT_FOUND');

  // JWT `iat` has second precision; a token issued in the same second as the change is the
  // fresh one returned by the update itself.
  const changedAtSeconds = user.passwordChangedAt
    ? Math.floor(user.passwordChangedAt.getTime() / 1000)
    : 0;
  if (token.issuedAtSeconds < changedAtSeconds) {
    throw new UnauthorizedError('Session expired, please log in again', 'AUTH_TOKEN_REVOKED');
  }
  return { id: user._id.toString(), name: user.name, email: user.email, role: user.role };
}

export async function registerUser(input: RegisterInput): Promise<UserSession> {
  if (await User.exists({ email: input.email })) {
    throw new ConflictError('User already exists', 'USER_EXISTS');
  }
  // A concurrent duplicate still fails on the unique index and maps to 409.
  const user = await User.create(input);
  return toSession(user);
}

export async function loginUser(input: LoginInput): Promise<UserSession> {
  const user = await User.findOne({ email: input.email }).select('+password');
  if (!user || !(await bcrypt.compare(input.password, user.password))) {
    throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
  }
  return toSession(user);
}

const resetValidMinutes = 60;
const resetValidMs = resetValidMinutes * 60_000;
/** A new reset email is not sent if one went out this recently (stops email flooding). */
const resetResendCooldownMs = 60_000;

const hashResetToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Emails a one-time reset link. The caller always gets the same answer, whether or not the
 * address has an account, so this can't be used to find out who is registered.
 * ponytail: an existing account takes slightly longer (it sends the email), so the timing still
 * hints at it; queue the email in a background worker to remove that.
 */
export async function requestPasswordReset({ email }: ForgotPasswordInput) {
  const user = await User.findOne({ email }).select('name email passwordResetExpiresAt');
  if (!user) return;

  const issuedAt = user.passwordResetExpiresAt
    ? user.passwordResetExpiresAt.getTime() - resetValidMs
    : 0;
  if (Date.now() - issuedAt < resetResendCooldownMs) return;

  const token = randomBytes(32).toString('hex');
  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        passwordResetTokenHash: hashResetToken(token),
        passwordResetExpiresAt: new Date(Date.now() + resetValidMs),
      },
    },
  );
  await sendEmail({
    to: user.email,
    ...passwordResetEmail(user.name, storeUrl(`/reset-password?token=${token}`), resetValidMinutes),
  });
}

/**
 * Sets a new password from an emailed token. The token is claimed with one guarded update, so
 * two simultaneous uses can't both succeed; saving the password also signs out every other
 * session. Logs the user in, since they just proved they own the mailbox.
 */
export async function resetPassword({ token, password }: ResetPasswordInput): Promise<UserSession> {
  const claimed = await User.findOneAndUpdate(
    { passwordResetTokenHash: hashResetToken(token), passwordResetExpiresAt: { $gt: new Date() } },
    { $unset: { passwordResetTokenHash: 1, passwordResetExpiresAt: 1 } },
  )
    .select('_id')
    .lean();
  if (!claimed) {
    throw new BadRequestError('This reset link is invalid or has expired', 'RESET_TOKEN_INVALID');
  }

  const user = await User.findById(claimed._id);
  if (!user) throw new NotFoundError('User not found', 'USER_NOT_FOUND');
  user.password = password;
  await user.save();
  return toSession(user);
}

export async function getProfile(userId: string): Promise<PublicUser> {
  const user = await User.findById(userId).select('name email role').lean();
  if (!user) throw new NotFoundError('User not found', 'USER_NOT_FOUND');
  return toPublicUser(user);
}

export async function updateProfile(
  userId: string,
  input: UpdateProfileInput,
): Promise<UserSession> {
  const user = await User.findById(userId);
  if (!user) throw new NotFoundError('User not found', 'USER_NOT_FOUND');

  if (input.name) user.name = input.name;
  if (input.email) user.email = input.email;
  if (input.password) user.password = input.password;

  await user.save();
  return toSession(user);
}

// ponytail: unbounded admin list; the admin UI expects a full array. Paginate when user count grows.
export async function listUsers(): Promise<PublicUser[]> {
  const users = await User.find().select('name email role').sort({ createdAt: -1 }).lean();
  return users.map(toPublicUser);
}

export async function deleteUser(actorId: string, userId: string) {
  if (actorId === userId) {
    throw new BadRequestError('You cannot delete your own account', 'CANNOT_DELETE_SELF');
  }
  const deleted = await User.findByIdAndDelete(userId).select('_id').lean();
  if (!deleted) throw new NotFoundError('User not found', 'USER_NOT_FOUND');
}
