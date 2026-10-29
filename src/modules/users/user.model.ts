import bcrypt from 'bcryptjs';
import { model, Schema, type Types } from 'mongoose';
import type { UserRole } from './users.types.js';

const passwordSaltRounds = 10;

export interface SavedAddressRecord {
  _id: Types.ObjectId;
  label: string;
  address: string;
  city: string;
  postalCode: string;
  country: string;
  isDefault: boolean;
}

export interface UserRecord {
  _id: Types.ObjectId;
  name: string;
  email: string;
  password: string;
  role: UserRole;
  /** Tokens issued before this are rejected, so a password change logs out other sessions. */
  passwordChangedAt?: Date;
  /** Spendable reward points; only changed alongside a PointsTransaction row. */
  pointsBalance: number;
  /** Set when an order used the first-order discount; cleared if that order is cancelled. */
  firstOrderDiscountUsedAt?: Date;
  /** Plus benefits apply while this is in the future. Only changed with a Membership update. */
  membershipEndsAt?: Date;
  /** The customer's address book; at most one entry has `isDefault`. */
  addresses: SavedAddressRecord[];
  /** SHA-256 of the emailed reset token; the token itself is never stored. */
  passwordResetTokenHash?: string;
  passwordResetExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserRecord>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, trim: true },
    // Excluded by default so it can never leak through a query that forgot to omit it.
    password: { type: String, required: true, select: false },
    role: { type: String, required: true, enum: ['user', 'admin'], default: 'user' },
    passwordChangedAt: Date,
    pointsBalance: { type: Number, required: true, default: 0, min: 0 },
    firstOrderDiscountUsedAt: Date,
    membershipEndsAt: Date,
    addresses: [
      {
        label: { type: String, required: true, trim: true },
        address: { type: String, required: true, trim: true },
        city: { type: String, required: true, trim: true },
        postalCode: { type: String, required: true, trim: true },
        country: { type: String, required: true, trim: true },
        isDefault: { type: Boolean, required: true, default: false },
      },
    ],
    passwordResetTokenHash: { type: String, select: false, index: true },
    passwordResetExpiresAt: { type: Date, select: false },
  },
  { timestamps: true },
);

userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, passwordSaltRounds);
  if (!this.isNew) this.passwordChangedAt = new Date();
});

export const User = model<UserRecord>('User', userSchema);
