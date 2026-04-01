// Attaches a unique identifier to each request for tracing
import { v4 as uuid } from 'uuid';
import type { Request, Response, NextFunction } from 'express';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

// Only accepts incoming x-request-id if it has a safe format (alphanumeric, dashes, max 64 chars)
const SAFE_REQUEST_ID = /^[\w\-]{1,64}$/;

export function requestIdMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'] as string | undefined;
  req.requestId = (incoming && SAFE_REQUEST_ID.test(incoming)) ? incoming : uuid();
  next();
}
