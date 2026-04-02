// Centralized error handler — transforms errors into JSON responses
// In production, error messages are generic to avoid leaking internal state
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors';
import { config } from '../config';
import { logger } from '../logger';

const GENERIC_MESSAGES: Record<string, string> = {
  NOT_FOUND: 'Resource not found',
  VALIDATION_ERROR: 'Invalid request',
  CONFLICT: 'Conflict',
  UNAUTHORIZED: 'Unauthorized',
  PAYMENT_REQUIRED: 'Payment required',
};

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    const message = config.NODE_ENV === 'production'
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
