export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'USER_NOT_FOUND'
  | 'SYNC_REQUIRED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'CATEGORIES_UNAVAILABLE'
  | 'SYNC_IN_PROGRESS'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    if (details !== undefined) this.details = details;
    Error.captureStackTrace(this, new.target);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, code: ErrorCode = 'USER_NOT_FOUND') {
    super(code, 404, message);
  }
}

export class UpstreamError extends AppError {
  constructor(message: string, details?: unknown) {
    super('UPSTREAM_UNAVAILABLE', 502, message, details);
  }
}

/** `details` names which accounts are short, so the caller need not guess. */
export class SyncRequiredError extends AppError {
  constructor(message: string, details: unknown) {
    super('SYNC_REQUIRED', 409, message, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, options?: { cause?: unknown; code?: ErrorCode }) {
    super(options?.code ?? 'SYNC_IN_PROGRESS', 409, message);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}
