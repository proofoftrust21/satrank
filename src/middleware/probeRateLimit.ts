// Phase 9 C8 — /api/probe rate limits.
//
// Two limiters compose to protect SatRank's LN wallet from abuse:
//
//   - perToken: 10/h per L402 token (keyed on payment_hash = SHA256(preimage)).
//     Blocks a single token from draining its quota fast enough to matter
//     before the user's client realises it's misbehaving.
//
//   - global: 100/h across ALL callers (keyed to the fixed string 'global').
//     Caps the maximum total spend on external invoices SatRank is willing
//     to underwrite in any one hour — cheap insurance against a coordinated
//     multi-token spam that individually stays under the per-token ceiling.
//
// Ordering in the request pipeline (see app.ts):
//   apertureGateAuth → perToken → global → balanceAuth → controller
// Both limiters run BEFORE balanceAuth so a 429 does not consume credits.
// Per-token runs before global because when both would reject we'd rather
// burn the attacker's per-token counter than the shared global headroom —
// that keeps the global window available for honest traffic.
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import { rateLimitHits } from './metrics';

const ONE_HOUR_MS = 60 * 60 * 1000;

const l402ResponseBody = (retryAfterSeconds: number) => ({
  error: {
    code: 'PROBE_RATE_LIMITED',
    message: `/api/probe rate limit exceeded — retry after ${retryAfterSeconds}s`,
  },
});

/** Extract payment_hash hex from an L402/LSAT Authorization header.
 *  Returns null when the header is absent or malformed — in that case
 *  the caller falls back to IP keying. */
function paymentHashFromHeader(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^(?:L402|LSAT)\s+\S+:([a-f0-9]{64})$/i);
  if (!match) return null;
  return crypto.createHash('sha256').update(Buffer.from(match[1], 'hex')).digest('hex');
}

export interface ProbeRateLimitOptions {
  perTokenPerHour: number;
  globalPerHour: number;
  /** Override the store factory — tests use this to isolate counters per-suite. */
  testOnlyKeyPrefix?: string;
}

export interface ProbeRateLimitMiddleware {
  perToken: (req: Request, res: Response, next: NextFunction) => void;
  global: (req: Request, res: Response, next: NextFunction) => void;
}

/** Build the two probe limiters with the given hourly caps. */
export function createProbeRateLimit(opts: ProbeRateLimitOptions): ProbeRateLimitMiddleware {
  const prefix = opts.testOnlyKeyPrefix ?? '';

  const perToken = rateLimit({
    windowMs: ONE_HOUR_MS,
    max: opts.perTokenPerHour,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request): string => {
      const hash = paymentHashFromHeader(req.headers.authorization);
      const id = hash ?? `ip:${req.ip ?? '0.0.0.0'}`;
      return `${prefix}pt:${id}`;
    },
    handler: (_req, res, _next, options) => {
      rateLimitHits.inc({ limiter: 'probe_per_token' });
      const retryAfter = Math.ceil(options.windowMs / 1000);
      res.status(options.statusCode).json(l402ResponseBody(retryAfter));
    },
  });

  const global = rateLimit({
    windowMs: ONE_HOUR_MS,
    max: opts.globalPerHour,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (): string => `${prefix}g:global`,
    handler: (_req, res, _next, options) => {
      rateLimitHits.inc({ limiter: 'probe_global' });
      const retryAfter = Math.ceil(options.windowMs / 1000);
      res.status(options.statusCode).json(l402ResponseBody(retryAfter));
    },
  });

  return { perToken, global };
}
