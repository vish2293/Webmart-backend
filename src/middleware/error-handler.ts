import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { isDuplicateKeyError } from '../lib/db.js';
import { AppError, NotFoundError } from '../lib/errors.js';

type ErrorBody = { message: string; code: string; requestId: string; details?: unknown };

export function notFound(req: Request, _res: Response, next: NextFunction) {
  next(new NotFoundError(`Not Found - ${req.method} ${req.path}`, 'ROUTE_NOT_FOUND'));
}

/** body-parser errors carry an HTTP status and a `type`. */
function isBodyParserError(error: unknown): error is { status: number; type: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    'status' in error &&
    typeof error.status === 'number'
  );
}

function toResponse(error: unknown): { status: number; body: Omit<ErrorBody, 'requestId'> } {
  if (error instanceof AppError) {
    const body = { message: error.message, code: error.code };
    return {
      status: error.statusCode,
      body: error.details === undefined ? body : { ...body, details: error.details },
    };
  }
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    const first = details[0];
    const message = first
      ? `${first.path ? `${first.path}: ` : ''}${first.message}`
      : 'Invalid input';
    return { status: 400, body: { message, code: 'VALIDATION_ERROR', details } };
  }
  if (isDuplicateKeyError(error)) {
    const field = Object.keys(error.keyValue ?? {})[0] ?? 'value';
    return {
      status: 409,
      body: { message: `A record with this ${field} already exists`, code: 'DUPLICATE' },
    };
  }
  if (error instanceof mongoose.Error.ValidationError) {
    return { status: 400, body: { message: error.message, code: 'VALIDATION_ERROR' } };
  }
  if (isBodyParserError(error) && error.status < 500) {
    const message =
      error.type === 'entity.too.large' ? 'Request body too large' : 'Malformed request body';
    return { status: error.status, body: { message, code: 'INVALID_BODY' } };
  }
  return { status: 500, body: { message: 'Internal server error', code: 'INTERNAL_ERROR' } };
}

export function errorHandler(error: unknown, req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(error);

  const { status, body } = toResponse(error);
  if (status >= 500) {
    req.log.error({ err: error }, 'Unhandled error');
  } else {
    // pino-http already logs the 4xx response line at warn level.
    req.log.debug({ code: body.code, status }, body.message);
  }

  res.status(status).json({ ...body, requestId: String(req.id) } satisfies ErrorBody);
}
