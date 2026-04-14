// API key authentication middleware
// Aperture gateway verification for L402-gated endpoints
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
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
    next(new AuthenticationError('X-API-Key header required. Request a key at contact@satrank.dev or see /api/docs.'));
    return;
  }

  if (!safeEqual(provided, config.API_KEY)) {
    next(new AuthenticationError('Invalid API key'));
    return;
  }

  next();
}

// Report auth: accepts EITHER X-API-Key OR a valid L402 token.
// L402 tokens are validated by checking SHA256(preimage) exists in token_balance.
// Reports are free — they don't consume quota from the token balance.
export function createReportAuth(db: Database.Database) {
  const stmtCheck = db.prepare('SELECT 1 FROM token_balance WHERE payment_hash = ?');

  return function reportAuth(req: Request, _res: Response, next: NextFunction): void {
    // Path A: API key (existing behavior)
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (apiKey && config.API_KEY && safeEqual(apiKey, config.API_KEY)) {
      next();
      return;
    }

    // Path B: L402 token — extract preimage, verify payment_hash exists in token_balance
    const authHeader = req.headers.authorization ?? '';
    const match = authHeader.match(/^(?:L402|LSAT)\s+\S+:([a-f0-9]{64})$/i);
    if (match) {
      const preimage = match[1];
      const paymentHash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest();
      const row = stmtCheck.get(paymentHash);
      if (row) {
        next(); // valid token, report is free (no quota consumed)
        return;
      }
    }

    // Path C: dev mode passthrough
    if (config.NODE_ENV !== 'production' && !config.API_KEY) {
      next();
      return;
    }

    next(new AuthenticationError('X-API-Key or valid L402 token required. Request a key at contact@satrank.dev or use your existing L402 token.'));
  };
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

  // Path A: Operator token bypass — nginx routes X-Aperture-Token requests
  // directly to Express (bypassing Aperture). The token proves the caller
  // is the operator or an internal service with the shared secret.
  // This path skips the localhost check because the request comes from
  // the public internet (req.ip = client IP, not 127.0.0.1).
  if (config.APERTURE_SHARED_SECRET) {
    const provided = req.headers['x-aperture-token'] as string | undefined;
    if (provided && safeEqual(provided, config.APERTURE_SHARED_SECRET)) {
      next();
      return;
    }
  }

  // Path B: L402 payment flow — Aperture sits between nginx and Express.
  // Aperture validates the L402 macaroon+preimage and forwards to Express
  // on loopback. The localhost check confirms the request came through
  // Aperture (port 8082 → port 3000 on 127.0.0.1).
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

  if (!isLocalhost) {
    next(new PaymentRequiredError());
    return;
  }

  // Additional defense-in-depth for Path B: if no L402 Authorization
  // header is present, the request bypassed Aperture (e.g., nginx
  // misconfiguration routing directly to Express on localhost). Block it.
  const hasL402Auth = (req.headers.authorization ?? '').startsWith('L402 ') ||
    (req.headers.authorization ?? '').startsWith('LSAT ');
  if (!hasL402Auth && config.APERTURE_SHARED_SECRET) {
    next(new PaymentRequiredError());
    return;
  }

  next();
}
