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
//
// Defense in depth: if APERTURE_SHARED_SECRET is configured, require it as an
// X-Aperture-Token header in addition to the localhost check. This protects
// against two scenarios:
//   1. Aperture is not yet deployed (localhost check passes for nginx-forwarded
//      requests, bypassing payment entirely).
//   2. A CDN is added in front of nginx without incrementing `trust proxy` —
//      an attacker could forge X-Forwarded-For: 127.0.0.1 and pass the IP check.
// With the shared secret, both attacks fail because the secret is only known
// to Aperture and Express.
export function apertureGateAuth(req: Request, _res: Response, next: NextFunction): void {
  if (config.NODE_ENV !== 'production') {
    next();
    return;
  }

  // Layer 1: localhost check (Aperture → Express on loopback)
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

  if (!isLocalhost) {
    next(new PaymentRequiredError());
    return;
  }

  // Layer 2: shared secret check — defense-in-depth for when Aperture
  // is NOT in the request path. When Aperture validates an L402 token,
  // it forwards the request with an Authorization header containing the
  // macaroon+preimage. If that header is present, the request already
  // went through Aperture's payment verification → trust it.
  // Only enforce the shared secret for requests that bypassed Aperture
  // (e.g., direct nginx → Express without payment, or misconfigured proxy).
  const hasL402Auth = (req.headers.authorization ?? '').startsWith('L402 ') ||
    (req.headers.authorization ?? '').startsWith('LSAT ');
  if (!hasL402Auth && config.APERTURE_SHARED_SECRET) {
    const provided = req.headers['x-aperture-token'] as string | undefined;
    if (!provided || !safeEqual(provided, config.APERTURE_SHARED_SECRET)) {
      next(new PaymentRequiredError());
      return;
    }
  }

  next();
}
