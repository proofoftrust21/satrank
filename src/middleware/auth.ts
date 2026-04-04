// API key authentication middleware
// Aperture gateway verification for L402-gated endpoints
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

class PaymentRequiredError extends AppError {
  constructor() {
    super('Payment required', 402, 'PAYMENT_REQUIRED');
    this.name = 'PaymentRequiredError';
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

// Verifies that the request came through Aperture (L402 gateway).
// Defense in depth: validates APERTURE_SHARED_SECRET so that even if Express is
// exposed directly (firewall misconfiguration, Aperture down), paid endpoints
// remain protected. Aperture must be configured to inject this secret in the
// X-Aperture-Auth header when forwarding paid requests.
// M6: data-driven passthrough — matches apiKeyAuth pattern.
// When APERTURE_SHARED_SECRET is not configured, allows passthrough (dev/test).
export function apertureGateAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!config.APERTURE_SHARED_SECRET) {
    next();
    return;
  }

  const apertureHeader = req.headers['x-aperture-auth'] as string | undefined;
  if (!apertureHeader || !apertureHeader.trim()) {
    next(new PaymentRequiredError());
    return;
  }

  // Verify the shared secret — prevents bypass if Express is reachable directly
  if (!safeEqual(apertureHeader.trim(), config.APERTURE_SHARED_SECRET)) {
    next(new PaymentRequiredError());
    return;
  }

  next();
}
