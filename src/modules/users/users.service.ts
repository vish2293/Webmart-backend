import bcrypt from 'bcryptjs';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from '../../lib/errors.js';
import { signAccessToken, type VerifiedToken } from './token.js';
import { User, type UserRecord } from './user.model.js';
import type { LoginInput, RegisterInput, UpdateProfileInput } from './users.validation.js';
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
