export type UserRole = 'user' | 'admin';

export type AuthenticatedUser = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
};

export type PublicUser = {
  _id: string;
  name: string;
  email: string;
  role: UserRole;
};

/** Returned by register, login and profile update. Shape matches the client's `Session`. */
export type UserSession = PublicUser & { token: string };
