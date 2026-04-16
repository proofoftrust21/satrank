// Custom error hierarchy for centralized error handling

export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly details?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  // Sim #5 #9: expose the missing resource name in the error body so agents
  // can tell which input was wrong (reporter vs target vs transaction) even
  // when prod sanitizes the message. Identifier itself is NOT echoed — it's
  // already client-supplied and leaking it back serves no purpose.
  constructor(resource: string, _identifier?: string) {
    super(`${resource} not found`, 404, 'NOT_FOUND', { resource });
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code: string = 'CONFLICT') {
    super(message, 409, code);
    this.name = 'ConflictError';
  }
}

// Specific 409 code for duplicate report/attestation — SDK's DuplicateReportError
// keys off `error.code === 'DUPLICATE_REPORT'`. Keeping 409 + ConflictError shape
// so existing callers that test for `instanceof ConflictError` still work.
export class DuplicateReportError extends ConflictError {
  constructor(message: string) {
    super(message, 'DUPLICATE_REPORT');
    this.name = 'DuplicateReportError';
  }
}
