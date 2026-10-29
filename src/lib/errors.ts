/** An expected failure with a stable code and a message that is safe to show clients. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    /** Optional machine-readable context for clients (must be safe to expose). */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, code = 'BAD_REQUEST') {
    super(400, code, message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Not authorized', code = 'UNAUTHORIZED') {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action', code = 'FORBIDDEN') {
    super(403, code, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, code = 'NOT_FOUND') {
    super(404, code, message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'CONFLICT', details?: unknown) {
    super(409, code, message, details);
  }
}

/** An upstream service (e.g. the payment gateway) failed or timed out. */
export class BadGatewayError extends AppError {
  constructor(message: string, code = 'BAD_GATEWAY', options?: ErrorOptions) {
    super(502, code, message);
    if (options?.cause) this.cause = options.cause;
  }
}
