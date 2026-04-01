// Centralized error handler — transforms errors into JSON responses
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors';
import { logger } from '../logger';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
      },
      requestId: req.requestId,
    });
    return;
  }

  // Unexpected error
  logger.error({ err, requestId: req.requestId }, 'Unhandled internal error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
    requestId: req.requestId,
  });
}
