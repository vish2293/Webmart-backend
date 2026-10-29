import { Types } from 'mongoose';
import { withTransaction } from '../../lib/db.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { User, type SavedAddressRecord } from './user.model.js';
import type { AddressInput } from './users.validation.js';

/** Enough for home, work and a few family addresses; stops unbounded growth of the user document. */
export const maxSavedAddresses = 10;

const toAddress = (address: SavedAddressRecord) => ({ ...address, _id: address._id.toString() });

export async function listAddresses(userId: string) {
  const user = await User.findById(userId).select('addresses').lean();
  if (!user) throw new NotFoundError('User not found', 'USER_NOT_FOUND');
  return (user.addresses ?? []).map(toAddress);
}

export async function addAddress(userId: string, input: AddressInput) {
  await withTransaction(async (session) => {
    const { isDefault: wantsDefault, ...fields } = input;
    const existing = await User.findById(userId).select('addresses').session(session).lean();
    if (!existing) throw new NotFoundError('User not found', 'USER_NOT_FOUND');
    const count = existing.addresses?.length ?? 0;
    if (count >= maxSavedAddresses) {
      throw new ConflictError(
        `You can save up to ${maxSavedAddresses} addresses. Delete one to add another.`,
        'ADDRESS_LIMIT',
      );
    }

    // The first address is always the default.
    const isDefault = wantsDefault || count === 0;
    if (isDefault && count > 0) {
      await User.updateOne(
        { _id: userId },
        { $set: { 'addresses.$[].isDefault': false } },
        { session },
      );
    }
    await User.updateOne(
      { _id: userId },
      { $push: { addresses: { _id: new Types.ObjectId(), ...fields, isDefault } } },
      { session },
    );
  });
  return listAddresses(userId);
}

export async function updateAddress(userId: string, addressId: string, input: AddressInput) {
  const { isDefault, ...fields } = input;
  const result = await User.updateOne(
    { _id: userId, 'addresses._id': addressId },
    {
      $set: Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [`addresses.$.${key}`, value]),
      ),
    },
  );
  if (result.matchedCount === 0) {
    throw new NotFoundError('Address not found', 'ADDRESS_NOT_FOUND');
  }
  return isDefault ? setDefaultAddress(userId, addressId) : listAddresses(userId);
}

export async function setDefaultAddress(userId: string, addressId: string) {
  await withTransaction(async (session) => {
    const exists = await User.exists({ _id: userId, 'addresses._id': addressId }).session(session);
    if (!exists) throw new NotFoundError('Address not found', 'ADDRESS_NOT_FOUND');
    await User.updateOne(
      { _id: userId },
      { $set: { 'addresses.$[].isDefault': false } },
      { session },
    );
    await User.updateOne(
      { _id: userId },
      { $set: { 'addresses.$[target].isDefault': true } },
      { session, arrayFilters: [{ 'target._id': new Types.ObjectId(addressId) }] },
    );
  });
  return listAddresses(userId);
}

export async function deleteAddress(userId: string, addressId: string) {
  await withTransaction(async (session) => {
    const user = await User.findById(userId).select('addresses').session(session).lean();
    const target = user?.addresses?.find((address) => address._id.toString() === addressId);
    if (!user || !target) throw new NotFoundError('Address not found', 'ADDRESS_NOT_FOUND');

    await User.updateOne(
      { _id: userId },
      { $pull: { addresses: { _id: target._id } } },
      { session },
    );
    // Deleting the default hands the role to the next address so one is always selected.
    const next = user.addresses.find((address) => !address._id.equals(target._id));
    if (target.isDefault && next) {
      await User.updateOne(
        { _id: userId },
        { $set: { 'addresses.$[next].isDefault': true } },
        { session, arrayFilters: [{ 'next._id': next._id }] },
      );
    }
  });
  return listAddresses(userId);
}
