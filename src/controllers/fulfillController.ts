// Phase 1 (2026-05-01) — POST /api/fulfill
//
// SatRank's strategic pivot lives behind one HTTP entry point. Agent submits
// an intent, max_sats, max_latency_ms; SatRank executes the L402 call across
// up to 4 ranked candidates and returns the body or refunds. NIP-98 auth
// binds the request to the agent_pubkey for accounting + idempotency.
//
// Feature-flagged via FULFILL_ENABLED env var (default false). Off → 503.
// On → live execution against the agent's token_balance (custodial v1).
//
// Failure shapes:
//   401 — NIP-98 invalid (signature, payload binding, URL mismatch, …)
//   400 — validation error (invalid intent / over caps)
//   402 — token_balance insufficient (agent must /api/deposit first)
//   429 — per-agent rate-limited (audit M2 — bounded fan-out)
//   502 — every candidate failed (refunded; attempts[] returned for diagnostics)
//   503 — feature disabled
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { verifyNip98 } from '../middleware/nip98';
import { logger } from '../logger';
import { ValidationError } from '../errors';
import { formatZodError } from '../utils/zodError';
import type { FulfillService } from '../services/fulfillService';

/** Hard cap on fulfill body shape — protects the orchestrator from a 100-MB
 *  intent that bypasses the express-level body limit. */
const fulfillRequestSchema = z.object({
  intent: z.object({
    category: z.string().min(1).max(64),
    keywords: z.array(z.string().max(64)).max(10).optional(),
    budget_sats: z.number().int().nonnegative().max(100000).optional(),
    max_latency_ms: z.number().int().min(100).max(60000).optional(),
    optimize: z.enum(['p_success', 'latency', 'reliability', 'cost']).optional(),
  }),
  max_sats: z.number().int().min(1).max(10000),
  max_latency_ms: z.number().int().min(500).max(30000),
});

/** Minimal per-process rate limiter — agent_pubkey → token bucket. Bounds
 *  fan-out per agent to prevent a single key from saturating the LND node.
 *  More sophisticated limits (insurance pool, fraud signals) ship in Phase 4.
 *  Sizes are read once at construction so a runtime env tweak doesn't
 *  silently apply only to new instances. Tests override via deps. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

interface RateBucketState {
  tokens: number;
  lastRefill: number;
}

export interface FulfillControllerDeps {
  fulfillService: FulfillService;
  enabled: boolean;
  /** Optional rate limit override; when omitted, reads from FULFILL_RATE_BUCKET
   *  / FULFILL_RATE_REFILL_PER_SEC env vars at construction time. */
  rateBucketSize?: number;
  rateRefillPerSec?: number;
}

export class FulfillController {
  private readonly fulfillService: FulfillService;
  private readonly enabled: boolean;
  private readonly bucketSize: number;
  private readonly refillPerSec: number;
  private readonly buckets = new Map<string, RateBucketState>();

  constructor(deps: FulfillControllerDeps) {
    this.fulfillService = deps.fulfillService;
    this.enabled = deps.enabled;
    this.bucketSize = deps.rateBucketSize ?? envInt('FULFILL_RATE_BUCKET', 5);
    this.refillPerSec = deps.rateRefillPerSec ?? envFloat('FULFILL_RATE_REFILL_PER_SEC', 0.5);
  }

  /** Build the absolute URL the NIP-98 client should have signed. */
  private fullUrl(req: Request): string {
    return `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`;
  }

  private consumeRateToken(agentPubkey: string): boolean {
    const now = Date.now() / 1000;
    let state = this.buckets.get(agentPubkey);
    if (!state) {
      state = { tokens: this.bucketSize - 1, lastRefill: now };
      this.buckets.set(agentPubkey, state);
      return true;
    }
    const elapsed = Math.max(0, now - state.lastRefill);
    state.tokens = Math.min(
      this.bucketSize,
      state.tokens + elapsed * this.refillPerSec,
    );
    state.lastRefill = now;
    if (state.tokens < 1) return false;
    state.tokens -= 1;
    return true;
  }

  handle = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!this.enabled) {
        res.status(503).json({
          error: 'fulfill_disabled',
          message: 'POST /api/fulfill is gated behind FULFILL_ENABLED. Contact ops to enable.',
        });
        return;
      }

      // Step 1 — NIP-98 auth, agent_pubkey provenance.
      const authHeader = req.headers.authorization;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? null;
      const auth = await verifyNip98(authHeader, 'POST', this.fullUrl(req), rawBody);
      if (!auth.valid || !auth.pubkey) {
        logger.warn(
          { detail: auth.detail, route: '/api/fulfill' },
          'NIP-98 rejected on /api/fulfill',
        );
        res.status(401).json({ error: 'invalid_auth', message: 'NIP-98 verification failed' });
        return;
      }
      const agentPubkey = auth.pubkey;

      // Step 2 — body validation.
      const parsed = fulfillRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(formatZodError(parsed.error, req.body));
      }
      const body = parsed.data;

      // Cap consistency: max_sats body must respect intent.budget_sats if set.
      if (body.intent.budget_sats != null && body.max_sats > body.intent.budget_sats) {
        res.status(400).json({
          error: 'caps_inconsistent',
          message: `max_sats (${body.max_sats}) exceeds intent.budget_sats (${body.intent.budget_sats})`,
        });
        return;
      }

      // Step 3 — per-agent rate limit.
      if (!this.consumeRateToken(agentPubkey)) {
        res.status(429).json({
          error: 'rate_limited',
          message: 'too many concurrent fulfill calls — back off and retry',
          retry_after_sec: Math.ceil(1 / this.refillPerSec),
        });
        return;
      }

      // Step 4 — execute.
      const result = await this.fulfillService.fulfill({
        agent_pubkey: agentPubkey,
        intent: body.intent,
        max_sats: body.max_sats,
        max_latency_ms: body.max_latency_ms,
      });

      switch (result.status) {
        case 'success':
          res.status(200).json({
            status: 'success',
            job_id: result.job_id,
            body: result.body,
            preimage: result.preimage,
            candidate_url: result.candidate_url,
            attempts: result.attempts,
            sats_spent: result.sats_spent,
            premium_sats: result.premium_sats,
          });
          return;
        case 'refunded':
          res.status(502).json({
            status: 'refunded',
            job_id: result.job_id,
            attempts: result.attempts,
            reason: result.reason,
          });
          return;
        case 'insufficient_balance':
          res.status(402).json({
            error: 'insufficient_balance',
            required_sats: result.required_sats,
            available_sats: result.available_sats,
            message: 'top up via POST /api/deposit and retry',
          });
          return;
      }
    } catch (err) {
      next(err);
    }
  };
}
