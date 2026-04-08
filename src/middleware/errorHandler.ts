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
  UNAUTHORIZED: 'Unauthorized',
  PAYMENT_REQUIRED: 'Payment required',
};

// Codes whose real message is SAFE to expose to the client in production.
// VALIDATION_ERROR messages are written by formatZodError and contain only
// the field name, expected format, and the shape (not content) of the value
// the client just submitted — nothing the client doesn't already know.
const PASS_THROUGH_CODES = new Set(['VALIDATION_ERROR']);

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    const shouldSanitize = config.NODE_ENV === 'production' && !PASS_THROUGH_CODES.has(err.code);
    const message = shouldSanitize
      ? (GENERIC_MESSAGES[err.code] ?? 'An error occurred')
      : err.message;

    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message,
      },
      requestId: req.requestId,
    });
    return;
  }

  // Unexpected error — always log the real message, never expose it to the client in production
  logger.error({ err, requestId: req.requestId }, 'Unhandled internal error');
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
