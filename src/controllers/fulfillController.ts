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
  // Phase 3 — strict JSON Schema validation. Agent passes the canonical
  // hash of a previously-registered schema. Orchestrator fetches the
  // schema, runs ajv on every successful 2xx body, demotes mismatches
  // to delivery_schema_violation (Tier 2 refund).
  expected_schema_hash: z.string().regex(/^[a-f0-9]{64}$/, 'must be 64-char hex sha256').optional(),
  // Phase 7.4 — validator DSL strings. Format: `op:arg`. Allowed ops:
  // min_bytes, content_type, has_field, contains. Up to 10 entries. The
  // orchestrator runs them post-recall ; failure ⇒ delivery_validator_violation
  // ⇒ ClaimEngine opens a 5× multiplier claim against the operator bond.
  validators: z.array(
    z.string().regex(
      /^(min_bytes|content_type|has_field|contains):.{1,200}$/,
      'must match `<op>:<arg>` for op in {min_bytes,content_type,has_field,contains}',
    ),
  ).max(10).optional(),
  // Phase 6 — payment mode. 'deposit' uses the custodial token_balance
  // path (Phase 1 default); 'hold' uses a Lightning hold invoice the
  // agent pays per-call (non-custodial). Defaults to 'deposit' for
  // back-compat.
  mode: z.enum(['deposit', 'hold']).optional(),
  // Phase 6.1 — agent-supplied open-amount BOLT11 to receive the residue
  // refund when mode='hold' succeeds. Loose length check; fulfillService
  // calls parseBolt11 to validate semantically.
  refund_bolt11: z.string().min(20).max(2048).optional(),
});

/** Phase 6 — body for POST /api/fulfill/:job_id/execute. The intent must
 *  be re-supplied (server stores intent_hash, not the full intent shape)
 *  so the orchestrator can re-resolve. The hash is verified against the
 *  job's stored intent_hash to prevent agents tampering between the two
 *  steps. */
const executeRequestSchema = z.object({
  intent: z.object({
    category: z.string().min(1).max(64),
    keywords: z.array(z.string().max(64)).max(10).optional(),
    budget_sats: z.number().int().nonnegative().max(100000).optional(),
    max_latency_ms: z.number().int().min(100).max(60000).optional(),
    optimize: z.enum(['p_success', 'latency', 'reliability', 'cost']).optional(),
  }),
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

/** Audit L2 — strict UUID v4 format check on the :job_id path segment. */
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Audit L1 — whitelisted reason strings the controller is willing to
 *  pass through verbatim. Anything outside this set is bucketed under
 *  'unavailable' so future code paths can't silently leak LND internals. */
const ALLOWED_HOLD_UNAVAILABLE_REASONS = new Set<string>([
  'LND hold-invoice service not configured',
  'LND hold-invoice service not configured (admin macaroon missing)',
  'addHoldInvoice failed — see server logs',
]);
function sanitizeHoldUnavailableReason(raw: string | undefined): string {
  if (!raw) return 'unavailable';
  // Allow refund_bolt11 validation messages through verbatim — they are
  // produced server-side from a tight set of static strings + decode error.
  if (raw.startsWith('refund_bolt11 ')) return raw;
  return ALLOWED_HOLD_UNAVAILABLE_REASONS.has(raw) ? raw : 'unavailable';
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

  /** Phase 6 — POST /api/fulfill/:job_id/execute.
   *
   *  Step 2 of the hold-invoice flow. The agent has paid the hold-invoice
   *  generated by /api/fulfill (mode=hold) and now triggers the
   *  orchestrator. NIP-98 binds the request to the same agent_pubkey that
   *  created the job; pubkey mismatch is silently treated as not-found.
   *  The body must include the intent (server stores intent_hash, not the
   *  full intent — re-resolution requires the same input). */
  executeHold = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!this.enabled) {
        res.status(503).json({
          error: 'fulfill_disabled',
          message: 'Phase 6 hold-mode execute is gated behind FULFILL_ENABLED.',
        });
        return;
      }
      const authHeader = req.headers.authorization;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? null;
      const auth = await verifyNip98(authHeader, 'POST', this.fullUrl(req), rawBody);
      if (!auth.valid || !auth.pubkey) {
        logger.warn(
          { detail: auth.detail, route: '/api/fulfill/:job_id/execute' },
          'NIP-98 rejected on /api/fulfill/:job_id/execute',
        );
        res.status(401).json({ error: 'invalid_auth' });
        return;
      }
      const jobIdParam = req.params.job_id;
      const jobId = Array.isArray(jobIdParam) ? jobIdParam[0] : jobIdParam;
      // Audit L2 — strict UUID v4 format. The job_id we mint is randomUUID(),
      // anything else is invalid input we can reject at the boundary.
      if (!jobId || typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
        res.status(400).json({ error: 'invalid_job_id' });
        return;
      }
      const parsed = executeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(formatZodError(parsed.error, req.body));
      }
      // Audit H1 — per-agent rate limit. Without this a NIP-98-authed agent
      // can hammer /execute on one job_id and amplify orchestrator + LND
      // fan-out. Bucket size + refill mirror the /api/fulfill handler.
      if (!this.consumeRateToken(auth.pubkey)) {
        res.status(429).json({
          error: 'rate_limited',
          message: 'too many concurrent execute calls — back off and retry',
          retry_after_sec: Math.ceil(1 / this.refillPerSec),
        });
        return;
      }
      const result = await this.fulfillService.executeHoldFulfill({
        job_id: jobId,
        agent_pubkey: auth.pubkey,
        // Audit C2 + M3 — intent first-class. fulfillService verifies its
        // canonical hash against job.intent_hash before running the
        // orchestrator (no more silent redirect to a different category).
        intent: parsed.data.intent,
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
            residue_sats: result.residue_sats,
            refund_state: result.refund_state,
            body_sha256: result.body_sha256,
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
        case 'hold_invoice_required':
          // Agent hasn't paid yet — return the same 402 shape as fulfill().
          res.status(402).json({
            status: 'hold_invoice_required',
            job_id: result.job_id,
            payment_request: result.payment_request,
            payment_hash: result.payment_hash,
            invoice_amount_sats: result.invoice_amount_sats,
            expires_at: result.expires_at,
            refund_bolt11: result.refund_bolt11,
            message: 'pay the hold invoice first then call /execute again',
          });
          return;
        case 'hold_mode_unavailable':
          res.status(503).json({
            error: 'hold_mode_unavailable',
            reason: sanitizeHoldUnavailableReason(result.reason),
          });
          return;
        default:
          res.status(500).json({
            error: 'unexpected_status',
            status: result.status,
          });
          return;
      }
    } catch (err) {
      next(err);
    }
  };

  /** Phase 4 — POST /api/fulfill/quote. Preview without engagement.
   *  Returns top candidates with invoice estimates + premium estimates so
   *  the agent can decide whether to launch the actual fulfill. No NIP-98
   *  required (read-only) but rate-limited the same way to deter scraping
   *  the candidate-pricing surface. */
  quote = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!this.enabled) {
        res.status(503).json({
          error: 'fulfill_disabled',
          message: 'POST /api/fulfill/quote is gated behind FULFILL_ENABLED.',
        });
        return;
      }
      // Same body schema as /fulfill minus expected_schema_hash + max_latency_ms.
      const quoteSchema = z.object({
        intent: z.object({
          category: z.string().min(1).max(64),
          keywords: z.array(z.string().max(64)).max(10).optional(),
          budget_sats: z.number().int().nonnegative().max(100000).optional(),
          max_latency_ms: z.number().int().min(100).max(60000).optional(),
          optimize: z.enum(['p_success', 'latency', 'reliability', 'cost']).optional(),
        }),
        max_sats: z.number().int().min(1).max(10000),
      });
      const parsed = quoteSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(formatZodError(parsed.error, req.body));
      }
      const result = await this.fulfillService.quote(parsed.data);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  };

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
        expected_schema_hash: body.expected_schema_hash,
        mode: body.mode,
        refund_bolt11: body.refund_bolt11,
        validators: body.validators,
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
            residue_sats: result.residue_sats,
            refund_state: result.refund_state,
            body_sha256: result.body_sha256,
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
        case 'daily_cap_reached':
          // Phase 2 — drain protection. Agent has used too many absorbed
          // sats from SatRank's pool in the last 24h. Communicate the cap
          // + how much is left so the agent can plan retries or upgrade.
          res.status(429).json({
            error: 'daily_cap_reached',
            cap_sats: result.cap_sats,
            used_24h_sats: result.used_24h_sats,
            agent_age_bucket: result.agent_age_bucket,
            retry_after_sec: 86400,
            message: result.agent_age_bucket === 'fresh'
              ? 'fresh agents (<30d) are limited until trust accumulates'
              : 'daily cap reached — wait for the rolling window to refresh',
          });
          return;
        case 'circuit_breaker_open':
          // Phase 4 — pool exposure exceeded the safe floor. Refuse new
          // jobs so SatRank doesn't take on more risk than capital backs.
          // /api/oracle/fulfill exposes the live balance for diagnostics.
          res.status(503).json({
            error: 'circuit_breaker_open',
            pool_balance_sats: result.pool_balance_sats,
            min_pool_sats: result.min_pool_sats,
            retry_after_sec: 300,
            message: 'fulfill pool below safe floor — agents may retry once balance recovers (see /api/oracle/fulfill)',
          });
          return;
        case 'hold_invoice_required':
          // Phase 6 — agent must pay the hold invoice then call /execute.
          // 402 Payment Required is the canonical status for "you need to
          // pay before we can do this work" in HTTP semantics.
          res.status(402).json({
            status: 'hold_invoice_required',
            job_id: result.job_id,
            payment_request: result.payment_request,
            payment_hash: result.payment_hash,
            invoice_amount_sats: result.invoice_amount_sats,
            expires_at: result.expires_at,
            refund_bolt11: result.refund_bolt11,
            execute_endpoint: `/api/fulfill/${result.job_id}/execute`,
            message: 'pay the hold invoice and POST {intent} to execute_endpoint',
          });
          return;
        case 'hold_mode_unavailable':
          res.status(503).json({
            error: 'hold_mode_unavailable',
            reason: sanitizeHoldUnavailableReason(result.reason),
            message: 'try mode=deposit or contact ops',
          });
          return;
      }
    } catch (err) {
      next(err);
    }
  };
}
