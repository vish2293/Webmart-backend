import mongoose, { type ClientSession } from 'mongoose';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export async function connectDatabase() {
  mongoose.set('strictQuery', true);
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));

  const connection = await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 10_000 });

  // Checkout relies on multi-document transactions, which standalone servers don't support.
  const hello = await connection.connection.db?.admin().command({ hello: 1 });
  if (!hello?.setName && hello?.msg !== 'isdbgrid') {
    await mongoose.disconnect();
    throw new Error(
      'MongoDB must be a replica set (transactions are required). Atlas clusters are; ' +
        'for a local mongod, start it with --replSet rs0 and run rs.initiate().',
    );
  }
  logger.info({ host: connection.connection.host }, 'MongoDB connected');
}

export function disconnectDatabase() {
  return mongoose.disconnect();
}

export function isDatabaseReady() {
  return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}

/**
 * Runs `work` in a transaction. The driver retries the whole callback on transient errors
 * (including write conflicts between concurrent checkouts), so `work` must only touch the
 * database through `session`.
 */
export function withTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  return mongoose.connection.transaction(work);
}

export function isDuplicateKeyError(error: unknown): error is { code: 11000; keyValue?: object } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}
