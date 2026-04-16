// API key authentication middleware
// Aperture gateway verification for L402-gated endpoints
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import { config } from '../config';
import { AppError } from '../errors';
import { normalizeIdentifier } from '../utils/identifier';

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

// Constant-time comparison via HMAC — normalizes lengths to eliminate timing oracle.
// Exported so `/metrics` endpoints (api + crawler) reuse the same primitive —
// previously they used `===`/`!==` and were timing-leak vulnerable (audit C2).
export function safeEqual(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
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

// Report auth: accepts EITHER X-API-Key OR a valid L402 token with remaining > 0.
// Reports are free (no quota consumed) but require a non-exhausted token.
export function createReportAuth(db: Database.Database) {
  const stmtCheck = db.prepare('SELECT remaining FROM token_balance WHERE payment_hash = ?');
  const stmtDecideLog = db.prepare('SELECT 1 FROM decide_log WHERE payment_hash = ? AND target_hash = ?');

  return function reportAuth(req: Request, _res: Response, next: NextFunction): void {
    // Path A: API key (existing behavior)
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (apiKey && config.API_KEY && safeEqual(apiKey, config.API_KEY)) {
      next();
      return;
    }

    // Path B: L402 token — verify remaining > 0 (not exhausted) and target was queried
    const authHeader = req.headers.authorization ?? '';
    const match = authHeader.match(/^(?:L402|LSAT)\s+\S+:([a-f0-9]{64})$/i);
    if (match) {
      const preimage = match[1];
      const paymentHash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest();
      const row = stmtCheck.get(paymentHash) as { remaining: number } | undefined;
      if (row && row.remaining > 0) {
        // Target MUST be present — don't rely on downstream Zod to catch this
        const rawTarget = (req.body as Record<string, unknown>)?.target as string | undefined;
        if (!rawTarget || typeof rawTarget !== 'string') {
          next(new AuthenticationError('Report requires a target field'));
          return;
        }
        // decide_log stores the normalized hash (sha256 of a pubkey, or the
        // 64-char hash as-is). Agents often submit the pubkey in both /decide
        // and /report — we must apply the same normalization here or the
        // lookup silently misses. See sim #5 finding #7.
        const normalizedTargetHash = normalizeIdentifier(rawTarget).hash;
        // Verify this token has looked up the target. As of 2026-04-16 the
        // log is populated by /api/decide, /api/best-route, /api/profile,
        // /api/agent/:hash/verdict and /api/verdicts — any paid target
        // query works, not just /api/decide.
        const queried = stmtDecideLog.get(paymentHash, normalizedTargetHash);
        if (!queried) {
          next(new AuthenticationError(
            'Report rejected: this L402 token has no record of querying the target. ' +
            'Query the target first via /api/decide, /api/verdicts, /api/agent/:hash/verdict, ' +
            '/api/profile/:id, or /api/best-route (any works), then retry the report. ' +
            'If you used a different token to query, switch back to that token, or submit with X-API-Key.',
          ));
          return;
        }
        next();
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

  // Path B: Deposit token — nginx routes requests with Authorization: L402 deposit:*
  // directly to Express (bypassing Aperture). The token was created by /api/deposit
  // and pre-verified against LND. balanceAuth validates the actual balance.
  const authHeader = req.headers.authorization ?? '';
  if (/^L402\s+deposit:/i.test(authHeader)) {
    next();
    return;
  }

  // Path C: L402 payment flow — Aperture sits between nginx and Express.
  // Aperture validates the L402 macaroon+preimage and forwards to Express
  // on loopback. The localhost check confirms the request came through
  // Aperture (port 8082 → port 3000 on 127.0.0.1).
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

  if (!isLocalhost) {
    next(new PaymentRequiredError());
    return;
  }

  // Additional defense-in-depth for Path C: if no L402 Authorization
  // header is present, the request bypassed Aperture (e.g., nginx
  // misconfiguration routing directly to Express on localhost). Block it.
  const hasL402Auth = authHeader.startsWith('L402 ') || authHeader.startsWith('LSAT ');
  if (!hasL402Auth && config.APERTURE_SHARED_SECRET) {
    next(new PaymentRequiredError());
    return;
  }

  next();
}
