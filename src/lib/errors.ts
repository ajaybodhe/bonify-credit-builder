/**
 * One error taxonomy for the whole service. Every thrown AppError maps to a
 * stable HTTP status and a machine-readable `code` that clients can branch on,
 * so the wire contract does not depend on message wording.
 */
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

/**
 * The window is not fully covered by synced data, so we decline to score.
 *
 * `details` names the shortfall precisely — which accounts are short and by how
 * much — because the caller's remedy is mechanical (sync, then retry) and they
 * should not have to guess what to sync.
 */
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
