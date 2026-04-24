// API key authentication middleware
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import { config } from '../config';
import { AppError } from '../errors';
import { normalizeIdentifier } from '../utils/identifier';

class AuthenticationError extends AppError {
  constructor(message: string) {
    super(message, 401, 'UNAUTHORIZED');
    this.name = 'AuthenticationError';
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
export function createReportAuth(pool: Pool) {
  return async function reportAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
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
        const checkRes = await pool.query<{ remaining: number }>(
          'SELECT remaining FROM token_balance WHERE payment_hash = $1',
          [paymentHash],
        );
        const row = checkRes.rows[0];
        if (row && row.remaining > 0) {
          // Target MUST be present — don't rely on downstream Zod to catch this
          const rawTarget = (req.body as Record<string, unknown>)?.target as string | undefined;
          if (!rawTarget || typeof rawTarget !== 'string') {
            next(new AuthenticationError('Report requires a target field'));
            return;
          }
          // token_query_log stores the normalized hash (sha256 of a pubkey, or
          // the 64-char hash as-is). Agents often submit the pubkey — we must
          // apply the same normalization here or the lookup silently misses.
          // See sim #5 finding #7.
          const normalizedTargetHash = normalizeIdentifier(rawTarget).hash;
          // Verify this token has looked up the target. Post Phase 10 the log
          // is populated by /api/profile, /api/agent/:hash/verdict, and
          // /api/verdicts — any paid target query works.
          const queriedRes = await pool.query(
            'SELECT 1 FROM token_query_log WHERE payment_hash = $1 AND target_hash = $2',
            [paymentHash, normalizedTargetHash],
          );
          if (queriedRes.rowCount === 0) {
            next(new AuthenticationError(
              'Report rejected: this L402 token has no record of querying the target. ' +
              'Query the target first via /api/verdicts, /api/agent/:hash/verdict, ' +
              'or /api/profile/:id (any works), then retry the report. ' +
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
    } catch (err) {
      next(err);
    }
  };
}

// Phase 2 voie 3 — dispatch between legacy authenticated report and anonymous
// report. Détecte le chemin anonyme via :
//   - header X-L402-Preimage, ou
//   - body.preimage présent sans body.reporter
// Si anonyme, marque `req.isAnonymousReport=true` + `req.anonymousPreimage` et
// continue sans auth. Sinon, délègue au middleware d'auth legacy (apiKeyAuth ou
// createReportAuth). Ça laisse les deux chemins cohabiter sur /api/report.
export interface AnonymousReportRequest extends Request {
  isAnonymousReport?: boolean;
  anonymousPreimage?: string;
}
export function createReportDispatchAuth(legacyAuth: (req: Request, res: Response, next: NextFunction) => void) {
  return function reportDispatch(req: Request, res: Response, next: NextFunction): void {
    const body = (req.body as Record<string, unknown> | undefined) ?? undefined;
    const headerPreimageRaw = req.headers['x-l402-preimage'];
    const headerPreimage = typeof headerPreimageRaw === 'string' ? headerPreimageRaw : undefined;
    const bodyPreimage = typeof body?.preimage === 'string' ? (body.preimage as string) : undefined;
    const hasReporter = typeof body?.reporter === 'string';
    const preimage = headerPreimage ?? bodyPreimage;

    // Anonyme = preimage présent ET pas de reporter explicite. Si reporter est
    // fourni, on reste sur le chemin legacy (API-key/L402 + reporter field).
    if (preimage && !hasReporter) {
      (req as AnonymousReportRequest).isAnonymousReport = true;
      (req as AnonymousReportRequest).anonymousPreimage = preimage;
      next();
      return;
    }

    legacyAuth(req, res, next);
  };
}

