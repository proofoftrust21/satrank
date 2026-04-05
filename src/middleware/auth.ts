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
// Fail-closed: if API_KEY is not configured, reject in production.
// In dev/test (no API_KEY set), allows passthrough for easier development.
export function apiKeyAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!config.API_KEY) {
    if (config.NODE_ENV === 'production') {
      next(new AuthenticationError('API key not configured'));
      return;
    }
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

// L402 gate — Aperture handles payment verification and forwards valid requests.
// In production, Express is behind Hetzner firewall (port 3000 blocked externally).
// The only path to paid endpoints is: Internet → Nginx → Aperture → Express (localhost).
// So we trust requests from localhost in production. In dev, always passthrough.
export function apertureGateAuth(req: Request, _res: Response, next: NextFunction): void {
  if (config.NODE_ENV !== 'production') {
    next();
    return;
  }

  // In production: trust Aperture forwarding from localhost
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    next();
    return;
  }

  // Direct access from non-localhost in production — reject
  next(new PaymentRequiredError());
}
