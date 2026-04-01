// API key authentication middleware
// Placeholder for future L402 gating via Aperture
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { AppError } from '../errors';

class AuthenticationError extends AppError {
  constructor(message: string) {
    super(message, 401, 'UNAUTHORIZED');
    this.name = 'AuthenticationError';
  }
}

// Constant-time comparison via HMAC — normalizes lengths to eliminate timing oracle
function safeEqual(provided: string, expected: string): boolean {
  const key = crypto.randomBytes(32);
  const a = crypto.createHmac('sha256', key).update(provided).digest();
  const b = crypto.createHmac('sha256', key).update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Protects write endpoints with an API key via X-API-Key header
// In dev without API_KEY configured, allows passthrough (easier development)
// In production, API_KEY is required (validated in config.ts)
// TODO: replace with L402/macaroon verification via Aperture
export function apiKeyAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!config.API_KEY) {
    next();
    return;
  }

  const provided = req.headers['x-api-key'] as string | undefined;

  if (!provided) {
    next(new AuthenticationError('X-API-Key header required'));
    return;
  }

  if (!safeEqual(provided, config.API_KEY)) {
    next(new AuthenticationError('Invalid API key'));
    return;
  }

  next();
}
