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
import { verifyNip98, buildCanonicalNip98Url } from '../middleware/nip98';
import { config } from '../config';
import { logger } from '../logger';
import { ValidationError } from '../errors';
import { sendError, fulfillOutcomeToErrorCode, reasonToNextAction } from '../errors/errorEnvelope';
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
  // Phase 9.1 — speculative parallel probe. Default 1 (serial). Range [1,4].
  parallel_probe: z.number().int().min(1).max(4).optional(),
  // Phase 6 — payment mode. 'deposit' uses the custodial token_balance
  // path (Phase 1 default); 'hold' uses a Lightning hold invoice the
  // agent pays per-call (non-custodial). Defaults to 'deposit' for
  // back-compat.
  mode: z.enum(['deposit', 'hold']).optional(),
  // Phase 6.1 — agent-supplied open-amount BOLT11 to receive the residue
  // refund when mode='hold' succeeds. Loose length check; fulfillService
  // calls parseBolt11 to validate semantically.
  refund_bolt11: z.string().min(20).max(2048).optional(),
  // Sim 12 Fix B (2026-05-02) — agent-supplied recall body + headers.
  // Many parameterized L402 endpoints (bitcoinbenji /ai/classify needs
  // {"text":...}, /summarize needs {"task":...}) returned HTTP 200 with
  // {"error":"Missing 'X' field"} when the orchestrator hardcoded `{}`
  // as the recall body, classifying as delivery_low_quality. Letting
  // the agent provide the body unlocks these endpoints. Caps :
  //   - body 4 KB (covers JSON params for any reasonable text/code task)
  //   - up to 8 headers, 256 chars each — enough for X-API-Key style
  //     auxiliary auth that some operators bolt onto L402.
  recall_body: z.string().max(4096).optional(),
  recall_headers: z
    .record(z.string().max(64), z.string().max(256))
    .refine(h => Object.keys(h).length <= 8, 'at most 8 recall_headers')
    // Block headers that conflict with our L402 + transport semantics —
    // agents cannot override Authorization (we're paying with L402 token),
    // Host (would break TLS SNI), or hop-by-hop headers.
    .refine(
      h => !Object.keys(h).some(k =>
        /^(authorization|host|content-length|connection|transfer-encoding)$/i.test(k),
      ),
      'recall_headers may not override Authorization/Host/transport headers',
    )
    .optional(),
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
  /** Phase 9.2 — capability token service for Bearer-token bypass of the
   *  per-call NIP-98 round-trip. Optional ; absent = NIP-98 only. */
  capabilityTokens?: import('../services/capabilityTokenService').CapabilityTokenService;
  /** Phase 11B.2 — record terminal status into the agent's reputation
   *  profile. Optional so existing tests don't have to mount a repo. */
  reputationService?: import('../services/agentReputationService').AgentReputationService;
  /** Phase 11B.5 — bond service for the effective-tier rate-limit gate.
   *  Optional ; without it the rate-limit defaults to silver-tier params
   *  (matches pre-P11B.5 behaviour). */
  bondService?: import('../services/agentBondService').AgentBondService;
}

export class FulfillController {
  private readonly fulfillService: FulfillService;
  private readonly enabled: boolean;
  private readonly bucketSize: number;
  private readonly refillPerSec: number;
  private readonly buckets = new Map<string, RateBucketState>();
  private readonly capabilityTokens?: import('../services/capabilityTokenService').CapabilityTokenService;
  private readonly reputationService?: import('../services/agentReputationService').AgentReputationService;
  private readonly bondService?: import('../services/agentBondService').AgentBondService;

  constructor(deps: FulfillControllerDeps) {
    this.fulfillService = deps.fulfillService;
    this.enabled = deps.enabled;
    this.bucketSize = deps.rateBucketSize ?? envInt('FULFILL_RATE_BUCKET', 5);
    this.refillPerSec = deps.rateRefillPerSec ?? envFloat('FULFILL_RATE_REFILL_PER_SEC', 0.5);
    this.capabilityTokens = deps.capabilityTokens;
    this.reputationService = deps.reputationService;
    this.bondService = deps.bondService;
  }

  /** Phase 11B.5 — effective-tier cache. Avoids a DB roundtrip on every
   *  fulfill call. The cache is keyed by agent_pubkey, expires after
   *  TIER_CACHE_TTL_MS, and refreshes lazily on miss/expiry. Reputation
   *  + bond changes propagate within the TTL window — sufficient since
   *  the profile only changes at terminal status (1+ second granularity)
   *  and the bond changes only at deposit/slash time. */
  private readonly tierCache = new Map<string, { tier: import('../services/agentReputationService').ReputationTier; expiresAt: number }>();
  private static readonly TIER_CACHE_TTL_MS = 60_000;

  private async resolveEffectiveTier(agentPubkey: string): Promise<'bronze' | 'silver' | 'gold'> {
    // Back-compat : without reputation+bond deps the tier system isn't
    // wired, so we fall through to silver (matches the pre-P11B.5
    // behaviour where every agent had the same rate-limit). Once the
    // operator opts in to the tier gate by passing both services, we
    // start enforcing bronze for new pubkeys without bond/reputation.
    if (!this.reputationService || !this.bondService) return 'silver';
    const cached = this.tierCache.get(agentPubkey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.tier;
    const [profile, bondAvail] = await Promise.all([
      this.reputationService.getProfile(agentPubkey),
      this.bondService.availableForAgent(agentPubkey),
    ]);
    const tier = this.reputationService.effectiveTier(profile, bondAvail);
    this.tierCache.set(agentPubkey, { tier, expiresAt: now + FulfillController.TIER_CACHE_TTL_MS });
    return tier;
  }

  /** Per-tier bucket dimensions. Targets from autonomy audit P11B.5 :
   *    bronze : 5/min   (untrusted / unbonded)
   *    silver : 30/min  (matches existing default — bonded ≥1000 sats)
   *    gold   : 300/min (high-trust + bonded ≥10000 sats)
   *  Refill rate = throughput, bucket size = burst capacity. */
  private bucketParamsFor(tier: 'bronze' | 'silver' | 'gold'): { bucketSize: number; refillPerSec: number } {
    if (tier === 'gold') return { bucketSize: 30, refillPerSec: 5 };
    if (tier === 'silver') return { bucketSize: this.bucketSize, refillPerSec: this.refillPerSec };
    return { bucketSize: 1, refillPerSec: 5 / 60 };
  }

  /** Phase 11B.2 — record the terminal outcome into the agent profile.
   *  Best-effort, non-blocking : reputation observability never blocks a
   *  fulfill response. Validator violations are detected from the
   *  attempts array (any attempt with delivery_validator_violation flips
   *  the bucket from 'refunded' to 'validator_violation'). */
  private async recordReputation(
    agentPubkey: string,
    status: 'success' | 'refunded',
    attempts: Array<{ delivery_outcome?: string | null }> | undefined,
  ): Promise<void> {
    if (!this.reputationService) return;
    let bucket: 'success' | 'refunded' | 'validator_violation' = status;
    if (status === 'refunded' && attempts) {
      const hasViolation = attempts.some(a => a.delivery_outcome === 'delivery_validator_violation');
      if (hasViolation) bucket = 'validator_violation';
    }
    try {
      await this.reputationService.recordFulfillOutcome(agentPubkey, bucket);
    } catch (err) {
      logger.warn(
        { agent: agentPubkey.slice(0, 12), error: err instanceof Error ? err.message : String(err) },
        'FulfillController: reputation record failed (non-blocking)',
      );
    }
  }

  /** Phase 9.2 — Bearer token alternative to NIP-98 ; resolves the
   *  capability and returns the underlying agent_pubkey on success. */
  private resolveAuth(authHeader: string | undefined): { agent_pubkey: string } | null {
    if (!authHeader || !this.capabilityTokens) return null;
    const m = authHeader.match(/^Bearer\s+([0-9a-f]{64})$/i);
    if (!m) return null;
    const cap = this.capabilityTokens.consume(m[1]);
    if (!cap) return null;
    return { agent_pubkey: cap.agent_pubkey };
  }

  /** POST /api/fulfill/session — exchange a NIP-98 envelope for a short-lived
   *  Bearer token. Bypass of per-call NIP-98 dance for SLA-critical agents.
   *  Body : { ttl_sec?: number, max_calls?: number }. Returns { token,
   *  expires_at, max_calls }. */
  issueSession = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!this.enabled || !this.capabilityTokens) {
        sendError(res, 'fulfill_disabled');
        return;
      }
      const authHeader = req.headers.authorization;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? null;
      const auth = await verifyNip98(authHeader, 'POST', this.fullUrl(req), rawBody);
      if (!auth.valid || !auth.pubkey) {
        sendError(res, 'invalid_auth');
        return;
      }
      const sessionSchema = z.object({
        ttl_sec: z.number().int().min(60).max(1800).optional(),
        max_calls: z.number().int().min(1).max(500).optional(),
      });
      const parsed = sessionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ValidationError(formatZodError(parsed.error, req.body));
      }
      const cap = this.capabilityTokens.issue({
        agent_pubkey: auth.pubkey,
        ttl_sec: parsed.data.ttl_sec,
        max_calls: parsed.data.max_calls,
      });
      res.status(200).json({
        token: cap.token,
        expires_at: cap.expires_at,
        max_calls: cap.max_calls,
        token_type: 'Bearer',
      });
    } catch (err) {
      next(err);
    }
  };

  /** Build the absolute URL the NIP-98 client should have signed. */
  private fullUrl(req: Request): string {
    // Phase 12A audit fix HIGH-2 — canonical URL from SATRANK_API_BASE,
    // not from the client-supplied Host header. Prevents Host-trust replay
    // where an attacker behind a co-operating proxy crafts a NIP-98 envelope
    // bound to one URL while the request lands at a different one.
    return buildCanonicalNip98Url(req, config.SATRANK_API_BASE);
  }

  /** Phase 11B.5 — tier-aware rate-limit. Bucket size + refill rate scale
   *  with the agent's effective tier (reputation × bond). The token
   *  state is kept per-pubkey across tier transitions so an agent that
   *  was just promoted to gold doesn't lose their accumulated tokens —
   *  but tokens are CAPPED at the new tier's bucketSize on every call,
   *  so a downgrade (slash drains bond, demotion to bronze) immediately
   *  clamps the burst capacity. */
  private async consumeRateToken(agentPubkey: string): Promise<boolean> {
    const tier = await this.resolveEffectiveTier(agentPubkey);
    const { bucketSize, refillPerSec } = this.bucketParamsFor(tier);
    const now = Date.now() / 1000;
    let state = this.buckets.get(agentPubkey);
    if (!state) {
      state = { tokens: Math.max(0, bucketSize - 1), lastRefill: now };
      this.buckets.set(agentPubkey, state);
      return true;
    }
    const elapsed = Math.max(0, now - state.lastRefill);
    state.tokens = Math.min(
      bucketSize,
      state.tokens + elapsed * refillPerSec,
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
        sendError(res, 'fulfill_disabled', { message: 'Phase 6 hold-mode execute is gated behind FULFILL_ENABLED.' });
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
        sendError(res, 'invalid_auth');
        return;
      }
      const jobIdParam = req.params.job_id;
      const jobId = Array.isArray(jobIdParam) ? jobIdParam[0] : jobIdParam;
      // Audit L2 — strict UUID v4 format. The job_id we mint is randomUUID(),
      // anything else is invalid input we can reject at the boundary.
      if (!jobId || typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
        sendError(res, 'invalid_job_id');
        return;
      }
      const parsed = executeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(formatZodError(parsed.error, req.body));
      }
      // Audit H1 — per-agent rate limit. Without this a NIP-98-authed agent
      // can hammer /execute on one job_id and amplify orchestrator + LND
      // fan-out. Bucket size + refill mirror the /api/fulfill handler.
      if (!(await this.consumeRateToken(auth.pubkey))) {
        sendError(res, 'rate_limited', {
          message: 'too many concurrent execute calls — back off and retry',
          retry_after_ms: Math.ceil(1 / this.refillPerSec) * 1000,
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
          // Phase 11A.2 — additive next_action hint without breaking the
          // existing { status:'refunded', job_id, attempts, reason } shape.
          res.status(502).json({
            status: 'refunded',
            job_id: result.job_id,
            attempts: result.attempts,
            reason: result.reason,
            next_action: reasonToNextAction(result.reason),
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
        sendError(res, 'fulfill_disabled', { message: 'POST /api/fulfill is gated behind FULFILL_ENABLED. Contact ops to enable.' });
        return;
      }

      // Step 1 — auth. Phase 9.2 fast-path : Bearer capability token first
      // (single ~5µs Map lookup), fall back to full NIP-98 verification on
      // miss. Both surfaces yield the same agent_pubkey provenance.
      const authHeader = req.headers.authorization;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? null;
      let agentPubkey: string;
      const cap = this.resolveAuth(authHeader);
      if (cap) {
        agentPubkey = cap.agent_pubkey;
      } else {
        const auth = await verifyNip98(authHeader, 'POST', this.fullUrl(req), rawBody);
        if (!auth.valid || !auth.pubkey) {
          logger.warn(
            { detail: auth.detail, route: '/api/fulfill' },
            'NIP-98 rejected on /api/fulfill',
          );
          sendError(res, 'invalid_auth', { message: 'NIP-98 verification failed' });
          return;
        }
        agentPubkey = auth.pubkey;
      }

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
      if (!(await this.consumeRateToken(agentPubkey))) {
        sendError(res, 'rate_limited', {
          message: 'too many concurrent fulfill calls — back off and retry',
          retry_after_ms: Math.ceil(1 / this.refillPerSec) * 1000,
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
        parallel_probe: body.parallel_probe,
        recall_body: body.recall_body,
        recall_headers: body.recall_headers,
      });

      switch (result.status) {
        case 'success':
          // Phase 11B.2 — record success in the reputation ledger.
          void this.recordReputation(agentPubkey, 'success', result.attempts);
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
          // Phase 11A.2 — additive next_action hint without breaking the
          // existing { status:'refunded', job_id, attempts, reason } shape.
          // Phase 11B.2 — record refund/violation in reputation ledger.
          void this.recordReputation(agentPubkey, 'refunded', result.attempts);
          res.status(502).json({
            status: 'refunded',
            job_id: result.job_id,
            attempts: result.attempts,
            reason: result.reason,
            next_action: reasonToNextAction(result.reason),
          });
          return;
        case 'insufficient_balance':
          // Phase 11A.2 — next_action='abort_lane' (top-up requires user action).
          res.status(402).json({
            error: 'insufficient_balance',
            required_sats: result.required_sats,
            available_sats: result.available_sats,
            next_action: 'abort_lane',
            message: 'top up via POST /api/deposit and retry',
          });
          return;
        case 'daily_cap_reached':
          // Phase 2 — drain protection. Agent has used too many absorbed
          // sats from SatRank's pool in the last 24h. Communicate the cap
          // + how much is left so the agent can plan retries or upgrade.
          // Phase 11A.2 — next_action='wait', retry_after_ms=24h.
          res.status(429).json({
            error: 'daily_cap_reached',
            cap_sats: result.cap_sats,
            used_24h_sats: result.used_24h_sats,
            agent_age_bucket: result.agent_age_bucket,
            retry_after_sec: 86400,
            retry_after_ms: 86_400_000,
            next_action: 'wait',
            message: result.agent_age_bucket === 'fresh'
              ? 'fresh agents (<30d) are limited until trust accumulates'
              : 'daily cap reached — wait for the rolling window to refresh',
          });
          return;
        case 'circuit_breaker_open':
          // Phase 4 — pool exposure exceeded the safe floor. Refuse new
          // jobs so SatRank doesn't take on more risk than capital backs.
          // /api/oracle/fulfill exposes the live balance for diagnostics.
          // Phase 11A.2 — additive next_action='wait' for autonomous agents.
          res.status(503).json({
            error: 'circuit_breaker_open',
            pool_balance_sats: result.pool_balance_sats,
            min_pool_sats: result.min_pool_sats,
            retry_after_sec: 300,
            retry_after_ms: 300_000,
            next_action: 'wait',
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
