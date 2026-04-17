// Centralized error handler — transforms errors into JSON responses
// In production, error messages are generic to avoid leaking internal state
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors';
import { config } from '../config';
import { logger } from '../logger';

// In production, messages for known error codes are replaced with sanitized
// versions so internal detail never reaches the client; unknown codes fall
// back to 'An error occurred'. See PASS_THROUGH_CODES below for the explicit
// whitelist of error codes that propagate the real message verbatim.
const GENERIC_MESSAGES: Record<string, string> = {
  NOT_FOUND: 'Resource not found',
  VALIDATION_ERROR: 'Invalid request',
  CONFLICT: 'Conflict',
  DUPLICATE_REPORT: 'Duplicate report',
  UNAUTHORIZED: 'Unauthorized',
  PAYMENT_REQUIRED: 'Payment required',
  MALFORMED_REQUEST: 'Malformed request body',
  PAYLOAD_TOO_LARGE: 'Payload too large',
};

// Codes whose real message is SAFE to expose to the client in production.
// VALIDATION_ERROR messages are written by formatZodError and contain only
// the field name, expected format, and the shape (not content) of the value
// the client just submitted — nothing the client doesn't already know.
const PASS_THROUGH_CODES = new Set(['VALIDATION_ERROR', 'BALANCE_EXHAUSTED', 'UNAUTHORIZED', 'TOKEN_UNKNOWN']);

// Errors thrown by express.json() / body-parser before the router dispatches.
// Body parser attaches `type` (string) and `status`/`statusCode` (number) to
// its errors, and throws a `SyntaxError` subclass for JSON parse failures.
interface BodyParserError extends Error {
  type?: string;
  status?: number;
  statusCode?: number;
}

function isBodyParserError(err: Error): err is BodyParserError {
  const candidate = err as BodyParserError;
  if (typeof candidate.type === 'string' && candidate.type.startsWith('entity.')) return true;
  // JSON parse failures surface as SyntaxError with a `status` of 400 set by body-parser
  if (err instanceof SyntaxError && typeof candidate.status === 'number') return true;
  return false;
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  // express.json() / body-parser errors — surface as 400/413 instead of 500.
  // These happen BEFORE any route handler runs (the parser middleware fails),
  // so they hit the error handler directly without going through AppError.
  if (isBodyParserError(err)) {
    const bpErr = err as BodyParserError;
    const status = bpErr.statusCode ?? bpErr.status ?? 400;
    const code = status === 413 ? 'PAYLOAD_TOO_LARGE' : 'MALFORMED_REQUEST';
    const message = config.NODE_ENV === 'production'
      ? (GENERIC_MESSAGES[code] ?? 'Invalid request')
      : err.message;
    res.status(status).json({
      error: { code, message },
      requestId: req.requestId,
    });
    return;
  }

  if (err instanceof AppError) {
    const shouldSanitize = config.NODE_ENV === 'production' && !PASS_THROUGH_CODES.has(err.code);
    const message = shouldSanitize
      ? (GENERIC_MESSAGES[err.code] ?? 'An error occurred')
      : err.message;

    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message,
        ...(err.details ? { details: err.details } : {}),
      },
      requestId: req.requestId,
    });
    return;
  }

  // Unexpected error — always log the real message, never expose it to the client in production.
  // Audit H10: in production, omit the full stack trace so internal paths,
  // function names, and Node internals stay out of logs. The error name + message
  // still convey enough for triage; stack is accessible in dev or via local repro.
  const errorLogPayload = config.NODE_ENV === 'production'
    ? { errName: err.name, errMessage: err.message, requestId: req.requestId }
    : { err, requestId: req.requestId };
  logger.error(errorLogPayload, 'Unhandled internal error');
  const message = config.NODE_ENV === 'production'
    ? 'Internal server error'
    : (err.message || 'Internal server error');

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message,
    },
    requestId: req.requestId,
  });
}
