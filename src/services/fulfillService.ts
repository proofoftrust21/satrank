// Phase 1 (2026-05-01) — Fulfill proxy v1 (custodial mode).
//
// SatRank's strategic pivot: agents stop paying L402 endpoints directly and
// start paying SatRank, who executes the call across N candidates with retry
// + body validation, returns the result on the first success, or refunds
// everything on full failure.
//
// This is the "would_have_accomplished_without_satrank: NO" primitive that
// flips the verdict from useful → indispensable (see project_fulfill_proxy_plan.md).
//
// V1 is custodial: the agent prepaid via /api/deposit, has a token_balance row
// with sat credits. fulfill() debits at success time, never on partial spend
// (partial spend during a failed attempt is absorbed by SatRank's pool — the
// agent is held harmless under "success-only billing").
//
// Refund logic Tier 1 only: a candidate that returns HTTP non-2xx after pay
// is treated as a failed attempt, the loop advances to the next candidate.
// Tier 2 (body-shape validation) is wired via bodyQualityHeuristics but the
// dispute queue + per-operator appeal flow ships in Phase 2.
//
// Premium formula:
//   premium = max(1, ceil(invoice_sats × 0.10 × (1 - p_e2e_pessimistic)))
// Charged success-only: if every candidate fails → no premium debit.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { logger } from '../logger';
import { fetchSafeExternal, SsrfBlockedError, readBodyCapped } from '../utils/ssrf';
import { parseL402Challenge } from '../utils/l402HeaderParser';
import { parseBolt11, InvalidBolt11Error } from '../utils/bolt11Parser';
import { evaluateBodyQuality } from '../utils/bodyQualityHeuristics';
import type { LndGraphClient } from '../crawler/lndGraphClient';
import type { IntentService } from './intentService';
import type { IntentRequest, IntentCandidate } from '../types/intent';
import type {
  FulfillJobRepository,
  FulfillAttempt,
} from '../repositories/fulfillJobRepository';
import type { RefundEngine } from './refundEngine';
import type { ClaimEngine } from './claimEngine';
import type { AgentCreditRepository } from '../repositories/agentCreditRepository';
import type { IntentResultCacheRepository } from '../repositories/intentResultCacheRepository';
import type { SignerService } from './signerService';
import { canonicalJson } from './signerService';
import type { EndpointSchemaRepository } from '../repositories/endpointSchemaRepository';
import type { PoolAccountingService } from './poolAccountingService';
import type { LndHoldInvoiceService } from './lndHoldInvoiceService';
import { InvoiceAlreadyCanceledError } from './lndHoldInvoiceService';
import { buildValidatorChain, validateAll } from './responseValidator';
import type { Pool } from 'pg';

const FETCH_TIMEOUT_MS = 8000;
const PAY_TIMEOUT_DEFAULT_SEC = 20;
const RECALL_BODY_MAX_BYTES = 256 * 1024;
const IDEMPOTENCY_WINDOW_SEC = 60;
const MAX_CANDIDATES = 4;
const PREMIUM_FLOOR_SATS = 1;
/** Phase 6.1 — outbound refund retries. Each cron tick attempts one pay;
 *  after this cap we mark the residue failed_absorbed (kept by SatRank
 *  pool) so the queue never blocks indefinitely on a hostile invoice. */
const RESIDUE_REFUND_MAX_ATTEMPTS = 5;

export interface FulfillRequest {
  agent_pubkey: string;
  intent: IntentRequest;
  max_sats: number;
  max_latency_ms: number;
  /** Phase 3 — agent declares the JSON Schema hash they expect the response
   *  to match. Orchestrator looks up the schema in endpoint_schemas, builds
   *  a jsonSchemaValidator, and runs it against every successful 2xx body.
   *  A schema-violating body is treated as delivery failure (Tier 2 refund
   *  classification, disputable per Phase 2). When the hash is unknown to
   *  SatRank, fulfill rejects with reason='unknown_schema_hash' rather
   *  than silently dropping the validation — surfaces operator/agent
   *  schema-distribution problems early. */
  expected_schema_hash?: string;
  /** Phase 7.4 — agent-supplied validator DSL strings layered ON TOP of the
   *  schema_hash check (which is operator-side semantic). Examples:
   *    `min_bytes:500`, `has_field:text`, `has_field:data.results`,
   *    `contains:meme`, `content_type:application/json`.
   *  Failure ⇒ delivery_validator_violation classification ⇒ ClaimEngine
   *  opens a 5× multiplier claim against the operator bond. Caps: 10 entries. */
  validators?: string[];
  /** Phase 9.1 — race the L402 probe (free 402 fetch) across the top N
   *  candidates in parallel and pay the first one that returns a valid
   *  challenge. Bounds latency to fastest probe + pay+recall, vs serial
   *  iteration that pays the latency of the SUM of slow candidates.
   *  Default 1 (serial, Phase 1-8 behavior). Cap 4. NO parallel pay :
   *  only one candidate is ever paid (the fastest probe winner). */
  parallel_probe?: number;
  /** Phase 6 — payment mode. 'deposit' (default, custodial via token_balance)
   *  or 'hold' (non-custodial via Lightning hold invoice). When 'hold', the
   *  fulfill() call returns a hold_invoice_required result with the BOLT11
   *  to pay; the agent then calls executeHoldFulfill() to trigger orchestrator. */
  mode?: 'deposit' | 'hold';
  /** Phase 6.1 — agent-supplied open-amount BOLT11 to receive the residue
   *  refund (= reserve_sats_max − sats_spent − premium) when mode='hold'
   *  succeeds. Optional; absent means residue is absorbed by the SatRank pool
   *  (the agent agreed to the worst-case price up-front). The invoice MUST be
   *  open-amount or the residue will fail to pay. Validated at create time. */
  refund_bolt11?: string;
}

export type FulfillSuccess = {
  status: 'success';
  job_id: string;
  body: string;
  preimage: string;
  candidate_url: string;
  attempts: FulfillAttempt[];
  sats_spent: number;
  premium_sats: number;
  /** Phase 9.3 — populated when the body was served from intent_result_cache
   *  (cross-agent amortization). Agent paid 10% premium ; original preimage
   *  + body_sha256 are still authoritative. */
  cache_hit?: boolean;
  cache_age_sec?: number;
  freshness_attestation?: {
    signature_b64: string;
    satrank_pubkey: string;
    signed_at_iso: string;
    payload_canonical_json: string;
  };
  /** Sim 9 Fix 1 (2026-05-01) — sha256 of the delivered body, hex. Already
   *  computed server-side and stored in fulfill_jobs.result_body_sha256.
   *  Compliance / lineage agents (Sim 9 a08, a09, a10) need this to bind
   *  the body cryptographically to the preimage without recomputing client-
   *  side. Returned on `success` only (refunded paths never deliver a body). */
  body_sha256?: string;
  /** Phase 6.1 — populated when mode='hold' and we settled a residue refund.
   *  refund_state telegrams the outbound-pay outcome to the SDK so agents can
   *  detect a stuck residue (failed_absorbed) without polling. Absent for
   *  deposit mode and for hold-mode jobs without refund_bolt11. */
  residue_sats?: number;
  refund_state?: 'not_required' | 'pending' | 'paid' | 'failed_absorbed';
};

export type FulfillRefunded = {
  status: 'refunded';
  job_id: string;
  attempts: FulfillAttempt[];
  reason: string;
};

export type FulfillInsufficientBalance = {
  status: 'insufficient_balance';
  required_sats: number;
  available_sats: number;
};

export type FulfillRateLimited = {
  status: 'daily_cap_reached';
  cap_sats: number;
  used_24h_sats: number;
  agent_age_bucket: 'fresh' | 'established';
};

export type FulfillCircuitOpen = {
  status: 'circuit_breaker_open';
  pool_balance_sats: number;
  min_pool_sats: number;
};

export type FulfillHoldInvoiceRequired = {
  status: 'hold_invoice_required';
  job_id: string;
  payment_request: string;
  payment_hash: string;
  invoice_amount_sats: number;
  expires_at: number;
  /** Phase 6.1 — surfaces back to the agent so they can confirm SatRank
   *  recorded the right destination. Empty string when none was supplied. */
  refund_bolt11?: string;
};

export type FulfillHoldUnavailable = {
  status: 'hold_mode_unavailable';
  reason: string;
};

export type FulfillResult =
  | FulfillSuccess
  | FulfillRefunded
  | FulfillInsufficientBalance
  | FulfillRateLimited
  | FulfillCircuitOpen
  | FulfillHoldInvoiceRequired
  | FulfillHoldUnavailable;

export interface FulfillServiceDeps {
  pool: Pool;
  fulfillJobRepo: FulfillJobRepository;
  intentService: IntentService;
  /** Audit Phase 6.1 — payInvoice is reused for outbound residue refunds
   *  (`amtSatOverride` lets us pay an open-amount BOLT11). The optional
   *  signature lives in LndGraphClient. */
  lndClient: Pick<LndGraphClient, 'payInvoice'>;
  /** Phase 2 — refund classification + per-agent daily cap + ledger writes.
   *  Optional for back-compat with the Phase 1 tests; production wiring
   *  always passes a real instance. */
  refundEngine?: RefundEngine;
  /** Phase 7.3 — opens agent_claims on Tier-2 outcomes against operator
   *  bonds. Optional ; absent means no claims (Phase 1-6 behavior). */
  claimEngine?: ClaimEngine;
  /** Phase 9.4 — reputation credit line. +1 sat per delivery_ok ;
   *  borrowable against future fulfills. Optional. */
  agentCreditRepo?: AgentCreditRepository;
  /** Phase 9.3 — intent-keyed result cache + signed freshness attestation.
   *  Optional (absent → no caching, every call hits real upstream). */
  intentCacheRepo?: IntentResultCacheRepository;
  /** Phase 9.3 — signer for cache freshness attestations. */
  signer?: SignerService;
  /** Phase 3 — JSON Schema registry. Optional: when omitted, fulfill ignores
   *  expected_schema_hash and falls back to the heuristic body check. */
  endpointSchemaRepo?: EndpointSchemaRepository;
  /** Phase 4 — pool accounting + circuit breaker. Optional: when omitted,
   *  no breaker is enforced (Phase 1 tests stay green without wiring). */
  poolAccounting?: PoolAccountingService;
  /** Phase 6 — LND hold-invoice helpers. Required for mode='hold'; absent
   *  means hold mode requests get a clean 503 'hold_mode_unavailable'. */
  holdInvoiceService?: LndHoldInvoiceService;
  /** Self-pay guard: refuse to pay our own LND node (we already operate it
   *  for the registry crawler probes, see paidProbeRunner.ts:344). */
  selfPubkey?: string;
  /** Override for tests; defaults to global fetchSafeExternal. */
  fetchImpl?: typeof fetchSafeExternal;
  /** Override for tests; defaults to Date.now()/1000. */
  now?: () => number;
}

export class FulfillService {
  private readonly fetchImpl: typeof fetchSafeExternal;
  private readonly now: () => number;

  constructor(private readonly deps: FulfillServiceDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetchSafeExternal;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async fulfill(req: FulfillRequest): Promise<FulfillResult> {
    const intentHash = canonicalIntentHash(req.intent);
    const nowSec = this.now();

    // Idempotency window — same agent, same intent, same cap inside 60s
    // returns the prior result. Protects against retries / network glitches
    // duplicating spend.
    const existing = await this.deps.fulfillJobRepo.findRecentForIdempotency(
      req.agent_pubkey,
      intentHash,
      req.max_sats,
      IDEMPOTENCY_WINDOW_SEC,
      nowSec,
    );
    if (existing) {
      if (existing.status === 'success') {
        return {
          status: 'success',
          job_id: existing.job_id,
          body: '', // body is not persisted — agent must re-call to retrieve.
          preimage: existing.preimage ?? '',
          candidate_url:
            existing.attempts.find(a => a.delivery_outcome === 'delivery_ok')?.candidate_url ??
            '',
          attempts: existing.attempts,
          sats_spent: existing.sats_spent,
          premium_sats: existing.premium_sats,
        };
      }
      if (existing.status === 'refunded' || existing.status === 'aborted') {
        return {
          status: 'refunded',
          job_id: existing.job_id,
          attempts: existing.attempts,
          reason: existing.reason ?? 'idempotent replay of prior failure',
        };
      }
      // Audit M1 (2026-05-01) — for hold-mode jobs still awaiting payment,
      // return the existing BOLT11 instead of refusing as 'duplicate_in_flight'.
      // Agents who lost the response from the first call need the invoice
      // back; otherwise they wait 60s for the idempotency window to expire,
      // by which point the unpaid invoice is dangling on LND.
      if (
        existing.mode === 'hold'
        && existing.hold_invoice_state === 'awaiting_payment'
        && existing.hold_invoice_payment_request
        && existing.hold_invoice_payment_hash
      ) {
        return {
          status: 'hold_invoice_required',
          job_id: existing.job_id,
          payment_request: existing.hold_invoice_payment_request,
          payment_hash: existing.hold_invoice_payment_hash,
          invoice_amount_sats: existing.max_sats,
          expires_at: existing.hold_invoice_expires_at ?? 0,
          refund_bolt11: existing.refund_bolt11 ?? undefined,
        };
      }
      // in_flight on idempotency hit → caller should retry shortly. We treat
      // it as a hard refusal rather than racing two settles.
      return {
        status: 'refunded',
        job_id: existing.job_id,
        attempts: [],
        reason: 'duplicate_in_flight',
      };
    }

    // Phase 4 — circuit breaker. Pool balance below the configured floor
    // means SatRank can't safely take on new exposure: refuse atomically
    // before any external work. Returns 503 at the controller layer.
    if (this.deps.poolAccounting) {
      const pool = await this.deps.poolAccounting.getBalance();
      if (pool.circuit_breaker_open) {
        logger.warn(
          {
            agent_pubkey: req.agent_pubkey.slice(0, 12),
            balance_sats: pool.balance_sats,
            min_pool_sats: pool.min_pool_sats,
          },
          'Fulfill: rejected because pool circuit breaker is open',
        );
        return {
          status: 'circuit_breaker_open',
          pool_balance_sats: pool.balance_sats,
          min_pool_sats: pool.min_pool_sats,
        };
      }
    }

    const mode: 'deposit' | 'hold' = req.mode ?? 'deposit';

    // Phase 9.3 — intent-keyed cache lookup. Deposit mode only for v1 ; hold
    // mode coexistence with cached cross-agent fulfills is more involved
    // (would require refunding the hold-invoice). On cache hit, agent pays
    // 10% of the original sats_paid + premium floor, gets the cached body
    // plus a SatRank-signed freshness attestation.
    if (mode === 'deposit' && this.deps.intentCacheRepo) {
      const cached = await this.deps.intentCacheRepo.lookup(intentHash, nowSec);
      if (cached) {
        const cacheHitFee = Math.max(PREMIUM_FLOOR_SATS, Math.ceil(cached.source_sats_paid * 0.10));
        const balance = await this.fetchAgentBalance(req.agent_pubkey);
        if (balance >= cacheHitFee) {
          const debited = await this.debitAgentBalance(req.agent_pubkey, cacheHitFee);
          if (debited) {
            await this.deps.intentCacheRepo.incrementHit(cached.cache_id);
            const cacheAgeSec = nowSec - cached.created_at;
            // Sign freshness attestation if signer is wired.
            // Audit M1 (2026-05-01) — source_preimage is NEVER included in
            // the consumer-facing payload. The original preimage proves the
            // *source* agent paid, but cache consumers haven't paid that
            // invoice — exposing it would let them lie to downstream
            // verifiers ("look, I have the preimage, ergo I paid"). The
            // body_sha256 + source_job_id + SatRank signature are the
            // canonical freshness signal here.
            let attestation: FulfillSuccess['freshness_attestation'];
            if (this.deps.signer && this.deps.signer.isAvailable()) {
              const payload = canonicalJson({
                cache_age_sec: cacheAgeSec,
                cache_id: cached.cache_id,
                cache_served_at: nowSec,
                consumer_agent_pubkey: req.agent_pubkey,
                intent_hash: intentHash,
                source_body_sha256: cached.body_sha256,
                source_candidate_url: cached.source_candidate_url,
                source_job_id: cached.source_job_id,
                source_sats_paid: cached.source_sats_paid,
                satrank_version: 'phase9.3',
              });
              const signed = this.deps.signer.sign(payload);
              attestation = {
                signature_b64: signed.signature,
                satrank_pubkey: signed.satrank_pubkey,
                signed_at_iso: signed.signed_at,
                payload_canonical_json: signed.payload_canonical,
              };
            }
            // Phase 9.4 reward also fires on cache hits — the agent benefited
            // from a delivery, so credit accrues.
            if (this.deps.agentCreditRepo) {
              try {
                await this.deps.agentCreditRepo.incrementOnSuccess(req.agent_pubkey, this.now());
              } catch { /* non-fatal */ }
            }
            logger.info(
              {
                cache_id: cached.cache_id,
                consumer: req.agent_pubkey.slice(0, 12),
                cacheHitFee,
                cacheAgeSec,
                source_job_id: cached.source_job_id,
              },
              'Fulfill: cache hit (Phase 9.3)',
            );
            return {
              status: 'success',
              job_id: `cache:${cached.cache_id}`,
              body: cached.body,
              // Audit M1 — preimage is the empty string for cache hits ;
              // the consumer didn't pay an LN invoice. Downstream verifiers
              // should rely on freshness_attestation (Ed25519-signed) for
              // proof of legitimate delivery, not the preimage.
              preimage: '',
              candidate_url: cached.source_candidate_url,
              attempts: [],
              sats_spent: 0,
              premium_sats: cacheHitFee,
              body_sha256: cached.body_sha256,
              cache_hit: true,
              cache_age_sec: cacheAgeSec,
              freshness_attestation: attestation,
            };
          }
        }
        // Insufficient balance for cache hit fee → fall through to full
        // fulfill (which will hit the same insufficient_balance gate below
        // and may borrow against credit line).
      }
    }

    // Phase 6 — hold-invoice mode. Generate a hold-invoice on LND, store
    // the job in 'awaiting_payment' state, return 402-equivalent shape so
    // the agent can pay then call executeHoldFulfill().
    if (mode === 'hold') {
      if (!this.deps.holdInvoiceService || !this.deps.holdInvoiceService.isAvailable()) {
        return {
          status: 'hold_mode_unavailable',
          reason: 'LND hold-invoice service not configured (admin macaroon missing)',
        };
      }
      // Phase 6.1 — validate refund_bolt11 at create time so we don't
      // accept hold orders whose residue can't be refunded later. Open-
      // amount BOLT11 (no `amount` in the encoded invoice) is required
      // because we pay an arbitrary residue at settle time. parseBolt11
      // throws InvalidBolt11Error on malformed invoices.
      if (req.refund_bolt11) {
        try {
          const decoded = parseBolt11(req.refund_bolt11);
          if (decoded.amountSats != null && decoded.amountSats > 0) {
            return {
              status: 'hold_mode_unavailable',
              reason: 'refund_bolt11 must be an open-amount invoice (no amount encoded)',
            };
          }
        } catch (err) {
          return {
            status: 'hold_mode_unavailable',
            reason: `refund_bolt11 decode failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      // Reservation = max_sats + worst-case premium for any candidate at
      // p_e2e_pessimistic=0 (most expensive case). The actual settle will
      // be ≤ this. SatRank cancels and refunds residue automatically.
      const worstCasePremium = Math.max(
        PREMIUM_FLOOR_SATS,
        Math.ceil(req.max_sats * 0.10),
      );
      const reserveSats = req.max_sats + worstCasePremium;
      const expirySec = Math.max(120, Math.ceil(req.max_latency_ms / 1000) * 4);
      const expiresAt = nowSec + expirySec;
      let invoice;
      try {
        invoice = await this.deps.holdInvoiceService.addHoldInvoice({
          valueSat: reserveSats,
          memo: `SatRank fulfill ${intentHash.slice(0, 8)}`,
          expirySec,
        });
      } catch (err) {
        logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          'Fulfill: hold invoice creation failed',
        );
        return {
          status: 'hold_mode_unavailable',
          reason: 'addHoldInvoice failed — see server logs',
        };
      }
      const jobId = randomUUID();
      await this.deps.fulfillJobRepo.create({
        job_id: jobId,
        agent_pubkey: req.agent_pubkey,
        intent_hash: intentHash,
        max_sats: req.max_sats,
        max_latency_ms: req.max_latency_ms,
        created_at: nowSec,
        mode: 'hold',
        hold_invoice_payment_request: invoice.payment_request,
        hold_invoice_payment_hash: invoice.payment_hash,
        hold_invoice_preimage: invoice.preimage,
        hold_invoice_state: 'awaiting_payment',
        hold_invoice_expires_at: expiresAt,
        refund_bolt11: req.refund_bolt11,
      });
      return {
        status: 'hold_invoice_required',
        job_id: jobId,
        payment_request: invoice.payment_request,
        payment_hash: invoice.payment_hash,
        invoice_amount_sats: reserveSats,
        expires_at: expiresAt,
        refund_bolt11: req.refund_bolt11,
      };
    }

    // Token balance gate — agent must have prepaid at least max_sats + 1 sat
    // floor premium. We check before doing any external work.
    const balance = await this.fetchAgentBalance(req.agent_pubkey);
    const requiredSats = req.max_sats + PREMIUM_FLOOR_SATS;
    let creditBorrowed = 0;
    if (balance < requiredSats) {
      // Phase 9.4 — try to borrow against the agent's reputation credit line
      // before refusing. Borrowing only covers the deficit ; the agent must
      // still have most of the balance available. We charge against accumulated
      // delivery_credits earned from past successful fulfills.
      const deficit = requiredSats - balance;
      const borrowed = this.deps.agentCreditRepo
        ? await this.deps.agentCreditRepo.borrow(req.agent_pubkey, deficit, this.now())
        : false;
      if (!borrowed) {
        return {
          status: 'insufficient_balance',
          required_sats: requiredSats,
          available_sats: balance,
        };
      }
      creditBorrowed = deficit;
      logger.info(
        { agent_pubkey: req.agent_pubkey.slice(0, 12), deficit, balance, requiredSats },
        'Fulfill: agent borrowed against credit line (Phase 9.4)',
      );
    }

    // Phase 3 — schema lookup. Agent declares expected_schema_hash; we look
    // it up before doing any external work and reject early if unknown
    // (better UX than silently degrading to heuristics).
    let schemaJson: object | undefined;
    if (req.expected_schema_hash) {
      if (!this.deps.endpointSchemaRepo) {
        // Caller passed a hash but we have no registry wired — surface
        // explicitly rather than silently dropping the validation.
        return {
          status: 'refunded',
          job_id: '',
          attempts: [],
          reason: 'schema_registry_not_configured',
        };
      }
      const found = await this.deps.endpointSchemaRepo.findByHash(req.expected_schema_hash);
      if (!found) {
        return {
          status: 'refunded',
          job_id: '',
          attempts: [],
          reason: 'unknown_schema_hash',
        };
      }
      // schema_json is JSONB; we trust its shape (registration enforced JSON
      // Schema validity).
      schemaJson = found.schema_json as object;
    }

    // Phase 2 — per-agent daily refund cap. Drain protection: a malicious
    // agent who keeps choosing intents that map to broken endpoints could
    // farm refunds at SatRank's expense (we paid the operator, didn't bill
    // the agent → pool absorbs). The cap bounds that exposure; agents <30d
    // old get the strict 100-sat cap. See refundEngine.ts.
    if (this.deps.refundEngine) {
      // The agent's first-seen timestamp lives on the agents table when
      // we know them (NIP-98-signing agents are typically recorded by the
      // upstream pubkey crawl). We treat unknown agents as "fresh" by
      // default — strict cap.
      const firstSeen = await this.fetchAgentFirstSeen(req.agent_pubkey);
      const cap = await this.deps.refundEngine.checkDailyCap({
        agent_pubkey: req.agent_pubkey,
        agent_first_seen_at: firstSeen,
        worst_case_sats: req.max_sats,
      });
      if (!cap.allowed) {
        logger.info(
          {
            agent_pubkey: req.agent_pubkey.slice(0, 12),
            used_24h: cap.used_24h_sats,
            cap: cap.cap_sats,
            bucket: cap.agent_age_bucket,
          },
          'Fulfill: agent daily refund cap reached',
        );
        return {
          status: 'daily_cap_reached',
          cap_sats: cap.cap_sats,
          used_24h_sats: cap.used_24h_sats,
          agent_age_bucket: cap.agent_age_bucket,
        };
      }
    }

    // Create the in_flight job. From here every exit must call settle*.
    const jobId = randomUUID();
    await this.deps.fulfillJobRepo.create({
      job_id: jobId,
      agent_pubkey: req.agent_pubkey,
      intent_hash: intentHash,
      max_sats: req.max_sats,
      max_latency_ms: req.max_latency_ms,
      created_at: nowSec,
    });

    const attempts: FulfillAttempt[] = [];
    const startMs = Date.now();
    let satsSpent = 0;

    try {
      // Resolve candidates via existing intent ranking (Tier α: stage-aware
      // p_e2e DESC, see intentService.compareCandidates). We cap MAX_CANDIDATES
      // to bound the worst-case latency.
      const intentResp = await this.deps.intentService.resolveIntent(req.intent, undefined);
      const candidates = intentResp.candidates.slice(0, MAX_CANDIDATES);
      if (candidates.length === 0) {
        // Audit C1 — repay credit borrow on every failure exit (the deficit
        // covered an unrealised cost ; without repay the agent's debt sticks).
        await this.repayBorrowOnFailure(req.agent_pubkey, creditBorrowed);
        return await this.refund(jobId, attempts, 'no_candidates_for_intent');
      }

      // Phase 9.1 — speculative parallel probe. Race the L402 probe step
      // (free GET → 402) on the top N candidates, reorder so the fastest
      // valid-challenge candidate runs first. Pay-step is still serial
      // (only the winner pays). N capped at 4 ; default 1 (legacy serial).
      if (req.parallel_probe && req.parallel_probe > 1 && candidates.length > 1) {
        const N = Math.min(req.parallel_probe, candidates.length, 4);
        try {
          const winnerIdx = await this.raceParallelProbe(
            candidates.slice(0, N),
            startMs + req.max_latency_ms,
          );
          if (winnerIdx > 0 && winnerIdx < N) {
            // Move the winner to position 0 (preserves original order beyond).
            const [winner] = candidates.splice(winnerIdx, 1);
            candidates.unshift(winner);
            logger.debug(
              { jobId, winner_url: winner.endpoint_url, parallel_n: N },
              'Fulfill: parallel probe race winner reordered to head',
            );
          }
        } catch (err) {
          // All probes failed — fall through to serial loop, which will
          // re-probe and produce per-candidate skip attempts as usual.
          // Audit M2 (2026-05-01) — surface each sub-error from
          // AggregateError so post-mortem diagnostics can show which
          // candidates failed how. Previously the bare `err.message` for
          // AggregateError was the unhelpful "All promises were rejected".
          let probeErrors: string[] | undefined;
          if (err instanceof AggregateError && Array.isArray(err.errors)) {
            probeErrors = err.errors.map(e =>
              e instanceof Error ? e.message : String(e),
            );
          }
          logger.debug(
            {
              jobId,
              error: err instanceof Error ? err.message : String(err),
              probe_errors: probeErrors,
              parallel_n: N,
            },
            'Fulfill: parallel probe race surfaced no winner — falling back to serial',
          );
        }
      }

      for (const cand of candidates) {
        // Latency budget — give up before the next candidate if we're already
        // over the agent's max_latency_ms.
        if (Date.now() - startMs > req.max_latency_ms) {
          await this.repayBorrowOnFailure(req.agent_pubkey, creditBorrowed);
          return await this.refund(jobId, attempts, 'max_latency_exceeded');
        }

        // Honor the caller's max_sats — never start an attempt whose invoice
        // is known to exceed the remaining budget. Candidate price_sats is
        // metadata; the actual invoice from the L402 challenge is decoded
        // and re-checked below.
        const candidatePriceHint = cand.price_sats ?? 0;
        if (satsSpent + candidatePriceHint > req.max_sats) {
          attempts.push(this.skippedAttempt(cand, 'over_max_sats_hint'));
          continue;
        }

        // Sim 9 Fix 2 — pass absolute deadline + Phase 7.4 validators DSL.
        const attempt = await this.attemptCandidate(
          cand,
          req.max_sats - satsSpent,
          schemaJson,
          startMs + req.max_latency_ms,
          req.validators,
        );
        attempts.push(attempt);

        if (attempt.payment_outcome === 'pay_ok' && attempt.delivery_outcome === 'delivery_ok') {
          satsSpent += attempt.sats_paid;
          const premium = computePremium(attempt.sats_paid, cand);
          const finalSpent = satsSpent;
          const totalDebit = finalSpent + premium;

          // Atomic debit + settle. If the debit fails (race / insufficient),
          // we abort instead of returning a body without payment.
          const debited = await this.debitAgentBalance(req.agent_pubkey, totalDebit);
          if (!debited) {
            logger.error(
              { jobId, agent_pubkey: req.agent_pubkey.slice(0, 12), needed: totalDebit },
              'Fulfill: token_balance debit failed at settle time — aborting and not returning body',
            );
            await this.repayBorrowOnFailure(req.agent_pubkey, creditBorrowed);
            return await this.abort(jobId, attempts, 'token_balance_debit_failed');
          }

          const bodyHash = sha256OfBuffer(Buffer.from(attempt.detail ?? '', 'utf8'));
          const stored = await this.deps.fulfillJobRepo.settleSuccess({
            job_id: jobId,
            attempts,
            sats_spent: finalSpent,
            premium_sats: premium,
            preimage: attempt.preimage ?? '',
            result_body_sha256: bodyHash,
            settled_at: this.now(),
          });
          if (!stored) {
            logger.warn({ jobId }, 'Fulfill: settleSuccess affected 0 rows — race detected');
          }
          // Phase 9.4 — reward delivery_ok with +1 reputation sat. Auto-repay
          // any prior borrow that was used to fund this very call (deficit
          // covered, agent net : balance + earnings).
          if (this.deps.agentCreditRepo) {
            try {
              await this.deps.agentCreditRepo.incrementOnSuccess(req.agent_pubkey, this.now());
              if (creditBorrowed > 0) {
                await this.deps.agentCreditRepo.repay(req.agent_pubkey, creditBorrowed, this.now());
              }
            } catch (err) {
              logger.error(
                { jobId, error: err instanceof Error ? err.message : String(err) },
                'Fulfill: agent_credits update failed (continuing — non-fatal)',
              );
            }
          }
          // Phase 9.3 — write to cache for cross-agent amortization. TTL
          // depends on category : volatile categories (bitcoin) get short
          // TTL ; stable docs (data/government) longer. Hard-coded for v1.
          // Audit M4 (2026-05-01) — explicit body validation gate before
          // cache write. The orchestrator already only enters this branch
          // for delivery_outcome=delivery_ok, but the body itself may be
          // empty (bug somewhere upstream) or pathologically large (memory
          // amplification: one 50MB delivery × N consumers per TTL window).
          // Reject below 16 bytes (empty pings) and above 1MB to keep cache
          // entries useful AND bounded.
          const cacheBody = attempt.detail ?? '';
          const cacheBodyBytes = Buffer.byteLength(cacheBody, 'utf8');
          const CACHE_MIN_BYTES = 16;
          const CACHE_MAX_BYTES = 1_048_576;
          if (
            this.deps.intentCacheRepo &&
            cacheBodyBytes >= CACHE_MIN_BYTES &&
            cacheBodyBytes <= CACHE_MAX_BYTES
          ) {
            try {
              const ttlSec = ttlForCategory(req.intent.category);
              await this.deps.intentCacheRepo.create({
                intent_hash: intentHash,
                body: cacheBody,
                body_sha256: bodyHash,
                source_job_id: jobId,
                source_attempt_index: attempts.length - 1,
                source_candidate_url: cand.endpoint_url,
                source_operator_pubkey: cand.operator_pubkey,
                // Audit M1 — preimage stored for source-agent-only audit
                // trail, never re-emitted to consumers. See cache-hit
                // response at line ~390 which forces preimage='' on read.
                source_preimage: attempt.preimage ?? '',
                source_sats_paid: attempt.sats_paid,
                source_agent_pubkey: req.agent_pubkey,
                created_at: this.now(),
                expires_at: this.now() + ttlSec,
              });
            } catch (err) {
              logger.error(
                { jobId, error: err instanceof Error ? err.message : String(err) },
                'Fulfill: intent_result_cache.create failed (continuing — non-fatal)',
              );
            }
          } else if (this.deps.intentCacheRepo) {
            logger.debug(
              { jobId, cacheBodyBytes, CACHE_MIN_BYTES, CACHE_MAX_BYTES },
              'Fulfill: cache write skipped — body outside [min,max] gate',
            );
          }
          return {
            status: 'success',
            job_id: jobId,
            body: attempt.detail ?? '',
            preimage: attempt.preimage ?? '',
            candidate_url: cand.endpoint_url,
            attempts,
            sats_spent: finalSpent,
            premium_sats: premium,
            body_sha256: bodyHash,
          };
        }
        // Attempt failed — paid? (then absorb), or not paid? (no impact).
        // Either way, advance to next candidate.
        if (attempt.payment_outcome === 'pay_ok') {
          // Phase 2 — record the absorbed-sat event in the refund ledger.
          if (this.deps.refundEngine) {
            try {
              await this.deps.refundEngine.recordAttempt({
                job_id: jobId,
                agent_pubkey: req.agent_pubkey,
                attempt,
              });
            } catch (err) {
              logger.error(
                { jobId, candidate: cand.endpoint_url, error: err instanceof Error ? err.message : String(err) },
                'Fulfill: refund ledger write failed (continuing — backfill from attempts[])',
              );
            }
          }
          // Phase 7.3 — open an agent_claims row against the operator bond,
          // if claimEngine is wired and operator has an active bond. Idempotent
          // on (job_id, attempt_index). Failure is non-fatal — the orchestrator
          // continues to the next candidate regardless.
          if (this.deps.claimEngine) {
            try {
              const job = await this.deps.fulfillJobRepo.findById(jobId);
              if (job) {
                await this.deps.claimEngine.openClaimForAttempt({
                  job,
                  attempt_index: attempts.length - 1,  // we just pushed this attempt
                  attempt,
                });
              }
            } catch (err) {
              logger.error(
                { jobId, candidate: cand.endpoint_url, error: err instanceof Error ? err.message : String(err) },
                'Fulfill: claim engine openClaim failed (Phase 7.3 — non-fatal)',
              );
            }
          }
          logger.info(
            {
              jobId,
              candidate: cand.endpoint_url,
              sats_lost: attempt.sats_paid,
              delivery: attempt.delivery_outcome,
            },
            'Fulfill: candidate paid but delivery failed — absorbed by SatRank pool',
          );
        }
      }

      // Every candidate exhausted without success.
      await this.repayBorrowOnFailure(req.agent_pubkey, creditBorrowed);
      return await this.refund(jobId, attempts, 'all_candidates_failed');
    } catch (err) {
      logger.error(
        { jobId, error: err instanceof Error ? err.message : String(err) },
        'Fulfill: orchestrator threw — aborting',
      );
      await this.repayBorrowOnFailure(req.agent_pubkey, creditBorrowed);
      return await this.abort(jobId, attempts, 'orchestrator_exception');
    }
  }

  /** Phase 6 / 6.1 — second step of hold-invoice fulfill.
   *
   *  Audit C2 (2026-05-01): the intent must be re-supplied (server stores
   *  only intent_hash) AND the orchestrator MUST verify the supplied intent
   *  hashes to the same value as job.intent_hash. Otherwise a malicious
   *  agent could pay a cheap hold invoice on category=data then redirect
   *  /execute to category=finance keywords=[exchange] and have SatRank pay
   *  an adversary-controlled high-priced operator with the same money.
   *
   *  Audit M3 (2026-05-01): intent is now first-class on the signature
   *  (no more cast through `as unknown`). Controller passes it explicitly.
   *
   *  Audit C1 (2026-05-01): settle is wrapped to detect the cron beating
   *  us to cancel — InvoiceAlreadyCanceledError aborts the orchestrator
   *  before we return a body. settleSuccess return value is checked in
   *  the hold path (was only logged in deposit path).
   *
   *  Phase 6.1: on success, settle full reserve_sats_max (LND hold-invoice
   *  is binary), then if refund_bolt11 was supplied issue an outbound pay
   *  for residue = reserve_sats_max − sats_spent − premium. Failure mode
   *  is bounded: cron retries pending refunds; after MAX retries we mark
   *  failed_absorbed and the residue stays in pool. */
  async executeHoldFulfill(req: {
    job_id: string;
    agent_pubkey: string;
    intent: IntentRequest;
  }): Promise<FulfillResult> {
    if (!this.deps.holdInvoiceService) {
      return { status: 'hold_mode_unavailable', reason: 'LND hold-invoice service not configured' };
    }
    const job = await this.deps.fulfillJobRepo.findById(req.job_id);
    if (!job) {
      return { status: 'refunded', job_id: req.job_id, attempts: [], reason: 'job_not_found' };
    }
    if (job.mode !== 'hold') {
      return { status: 'refunded', job_id: req.job_id, attempts: [], reason: 'wrong_mode' };
    }
    if (job.agent_pubkey !== req.agent_pubkey) {
      // Owner mismatch — never reveal whether the job exists, just refuse.
      return { status: 'refunded', job_id: req.job_id, attempts: [], reason: 'owner_mismatch' };
    }

    // Audit C2 — verify the supplied intent hashes to job.intent_hash.
    // Constant-time comparison; both values are fixed-length sha256 hex.
    const suppliedHash = canonicalIntentHash(req.intent);
    const a = Buffer.from(suppliedHash, 'hex');
    const b = Buffer.from(job.intent_hash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      logger.warn(
        {
          jobId: req.job_id,
          agent_pubkey: req.agent_pubkey.slice(0, 12),
          job_intent_hash_first8: job.intent_hash.slice(0, 8),
          supplied_intent_hash_first8: suppliedHash.slice(0, 8),
        },
        'Fulfill: /execute intent hash mismatch — refusing to redirect orchestrator',
      );
      // Cancel the hold-invoice so the agent's HTLC unblocks; never run
      // the orchestrator on a divergent intent.
      if (job.hold_invoice_payment_hash) {
        try {
          await this.deps.holdInvoiceService.cancel(job.hold_invoice_payment_hash);
          await this.deps.fulfillJobRepo.setHoldInvoiceState(job.job_id, 'cancelled');
        } catch (err) {
          logger.warn(
            { jobId: req.job_id, error: err instanceof Error ? err.message : String(err) },
            'Fulfill: cancel-after-intent-mismatch failed; cron will retry',
          );
        }
      }
      return await this.abort(req.job_id, [], 'intent_hash_mismatch');
    }

    // Idempotent terminal states.
    if (job.status === 'success') {
      return {
        status: 'success',
        job_id: job.job_id,
        body: '', // body not persisted; agent must re-fulfill if they lost it
        preimage: job.preimage ?? '',
        candidate_url: job.attempts.find(a => a.delivery_outcome === 'delivery_ok')?.candidate_url ?? '',
        attempts: job.attempts,
        sats_spent: job.sats_spent,
        premium_sats: job.premium_sats,
        body_sha256: job.result_body_sha256 ?? undefined,
      };
    }
    if (job.status === 'refunded' || job.status === 'aborted') {
      return {
        status: 'refunded',
        job_id: job.job_id,
        attempts: job.attempts,
        reason: job.reason ?? 'idempotent replay',
      };
    }

    // Look up the hold-invoice on LND. Only ACCEPTED means we can run.
    if (!job.hold_invoice_payment_hash || !job.hold_invoice_preimage) {
      return await this.abort(job.job_id, [], 'hold_job_missing_invoice');
    }
    const lookup = await this.deps.holdInvoiceService.lookupState(job.hold_invoice_payment_hash);
    if (lookup.state === 'OPEN') {
      return {
        status: 'hold_invoice_required',
        job_id: job.job_id,
        payment_request: job.hold_invoice_payment_request ?? '',
        payment_hash: job.hold_invoice_payment_hash,
        invoice_amount_sats: job.max_sats,
        expires_at: job.hold_invoice_expires_at ?? 0,
      };
    }
    if (lookup.state === 'CANCELED' || lookup.state === 'EXPIRED' || lookup.state === 'UNKNOWN') {
      await this.deps.fulfillJobRepo.setHoldInvoiceState(job.job_id, 'cancelled');
      return await this.abort(job.job_id, job.attempts, `hold_invoice_${lookup.state.toLowerCase()}`);
    }
    if (lookup.state === 'SETTLED') {
      // Already settled but our DB says we're still in_flight — likely a
      // race or restart mid-settle. Repair: mark success with what we have.
      await this.deps.fulfillJobRepo.setHoldInvoiceState(job.job_id, 'settled');
      return await this.abort(job.job_id, job.attempts, 'hold_invoice_already_settled_no_orchestrator_record');
    }
    // lookup.state === 'ACCEPTED' — payment held in escrow, run the
    // orchestrator now.
    await this.deps.fulfillJobRepo.setHoldInvoiceState(job.job_id, 'accepted');

    const attempts: FulfillAttempt[] = [];
    const startMs = Date.now();
    let satsSpent = 0;

    try {
      // Hold mode does not support expected_schema_hash because the original
      // request payload is hashed-only; agents who need schema validation must
      // use deposit mode for now (Phase 6.2 follow-up).
      const schemaJson: object | undefined = undefined;

      // Audit M3 — req.intent is first-class now; no more `as unknown` cast.
      // We already verified it canonical-hashes to job.intent_hash above.
      const intentResp = await this.deps.intentService.resolveIntent(req.intent, undefined);
      const candidates = intentResp.candidates.slice(0, MAX_CANDIDATES);
      if (candidates.length === 0) {
        await this.deps.holdInvoiceService.cancel(job.hold_invoice_payment_hash);
        await this.deps.fulfillJobRepo.setHoldInvoiceState(job.job_id, 'cancelled');
        return await this.refund(job.job_id, attempts, 'no_candidates_for_intent');
      }

      for (const cand of candidates) {
        if (Date.now() - startMs > job.max_latency_ms) {
          await this.deps.holdInvoiceService.cancel(job.hold_invoice_payment_hash);
          await this.deps.fulfillJobRepo.setHoldInvoiceState(job.job_id, 'cancelled');
          return await this.refund(job.job_id, attempts, 'max_latency_exceeded');
        }
        const candidatePriceHint = cand.price_sats ?? 0;
        if (satsSpent + candidatePriceHint > job.max_sats) {
          attempts.push(this.skippedAttempt(cand, 'over_max_sats_hint'));
          continue;
        }
        // Sim 9 Fix 2 — pass deadline (hold mode same as deposit).
        const attempt = await this.attemptCandidate(cand, job.max_sats - satsSpent, schemaJson, startMs + job.max_latency_ms);
        attempts.push(attempt);

        if (attempt.payment_outcome === 'pay_ok' && attempt.delivery_outcome === 'delivery_ok') {
          satsSpent += attempt.sats_paid;
          const premium = computePremium(attempt.sats_paid, cand);

          // Audit C1 — try to settle, BUT distinguish "already settled"
          // (idempotent no-op, ok) from "already canceled" (cron beat us;
          // agent's HTLC unblocked; SatRank gets nothing). On the latter
          // we MUST abort before returning the body so SatRank doesn't
          // leak the body without payment.
          try {
            await this.deps.holdInvoiceService.settle(job.hold_invoice_preimage);
          } catch (err) {
            if (err instanceof InvoiceAlreadyCanceledError) {
              logger.error(
                { jobId: job.job_id, preimage_prefix: err.preimagePrefix },
                'Fulfill: hold invoice was canceled before settle (cron race) — aborting',
              );
              await this.deps.fulfillJobRepo.setHoldInvoiceState(job.job_id, 'cancelled');
              return await this.abort(job.job_id, attempts, 'hold_invoice_canceled_before_settle');
            }
            logger.error(
              { jobId: job.job_id, error: err instanceof Error ? err.message : String(err) },
              'Fulfill: settleInvoice failed mid-success — aborting before returning body',
            );
            return await this.abort(job.job_id, attempts, 'settle_invoice_failed');
          }
          // Audit H4 — strict state-machine transition. False return means
          // a concurrent writer landed first; abort defensively.
          const stateOk = await this.deps.fulfillJobRepo.setHoldInvoiceState(job.job_id, 'settled');
          if (!stateOk) {
            logger.error(
              { jobId: job.job_id },
              'Fulfill: hold_invoice_state transition to settled rejected — aborting',
            );
            return await this.abort(job.job_id, attempts, 'hold_state_transition_rejected');
          }

          // Audit C1 — settleSuccess affected-rows check (was only in deposit
          // path). 0 rows = the cron already wrote a terminal status; we must
          // abort and not return the body.
          const bodyHash = sha256OfBuffer(Buffer.from(attempt.detail ?? '', 'utf8'));
          const stored = await this.deps.fulfillJobRepo.settleSuccess({
            job_id: job.job_id,
            attempts,
            sats_spent: satsSpent,
            premium_sats: premium,
            preimage: attempt.preimage ?? '',
            result_body_sha256: bodyHash,
            settled_at: this.now(),
          });
          if (!stored) {
            logger.error(
              { jobId: job.job_id },
              'Fulfill: settleSuccess affected 0 rows in hold mode — terminal race, aborting',
            );
            return await this.abort(job.job_id, attempts, 'hold_settle_race_terminal');
          }

          // Phase 6.1 — residue refund. settle claimed the full reserveSats;
          // residue = reserveSats − sats_spent − premium. Pay it out via
          // payInvoice(refund_bolt11, amt=residue) when the agent supplied
          // an open-amount BOLT11. On failure we mark refund_state='pending'
          // so the cron retries.
          const reserveSats = job.max_sats + Math.max(
            PREMIUM_FLOOR_SATS,
            Math.ceil(job.max_sats * 0.10),
          );
          const residueSats = Math.max(0, reserveSats - satsSpent - premium);
          let refundState: 'not_required' | 'pending' | 'paid' | 'failed_absorbed' = 'not_required';
          if (residueSats > 0 && job.refund_bolt11) {
            refundState = await this.payResidueRefund(job.job_id, job.refund_bolt11, residueSats);
          } else if (residueSats > 0) {
            refundState = 'failed_absorbed';
            await this.deps.fulfillJobRepo.setRefundState({
              job_id: job.job_id,
              state: 'failed_absorbed',
              refund_amount_sats: residueSats,
              refund_last_error: 'no_refund_bolt11_supplied',
              settled_at: this.now(),
            });
          } else {
            await this.deps.fulfillJobRepo.setRefundState({
              job_id: job.job_id,
              state: 'not_required',
              refund_amount_sats: 0,
              settled_at: this.now(),
            });
          }

          return {
            status: 'success',
            job_id: job.job_id,
            body: attempt.detail ?? '',
            preimage: attempt.preimage ?? '',
            candidate_url: cand.endpoint_url,
            attempts,
            sats_spent: satsSpent,
            premium_sats: premium,
            residue_sats: residueSats,
            refund_state: refundState,
            body_sha256: bodyHash,
          };
        }

        if (attempt.payment_outcome === 'pay_ok' && this.deps.refundEngine) {
          try {
            await this.deps.refundEngine.recordAttempt({
              job_id: job.job_id,
              agent_pubkey: job.agent_pubkey,
              attempt,
            });
          } catch (err) {
            logger.error(
              { jobId: job.job_id, error: err instanceof Error ? err.message : String(err) },
              'Fulfill: refund ledger write failed (hold mode) — continuing',
            );
          }
        }
        // Phase 7.3 — claim engine hook for hold mode.
        if (attempt.payment_outcome === 'pay_ok' && this.deps.claimEngine) {
          try {
            await this.deps.claimEngine.openClaimForAttempt({
              job,
              attempt_index: attempts.length - 1,
              attempt,
            });
          } catch (err) {
            logger.error(
              { jobId: job.job_id, error: err instanceof Error ? err.message : String(err) },
              'Fulfill: claim engine openClaim failed (hold mode, Phase 7.3 — non-fatal)',
            );
          }
        }
      }

      // Every candidate failed — cancel the hold-invoice; agent gets refund.
      await this.deps.holdInvoiceService.cancel(job.hold_invoice_payment_hash);
      await this.deps.fulfillJobRepo.setHoldInvoiceState(job.job_id, 'cancelled');
      return await this.refund(job.job_id, attempts, 'all_candidates_failed');
    } catch (err) {
      logger.error(
        { jobId: job.job_id, error: err instanceof Error ? err.message : String(err) },
        'Fulfill: hold-mode orchestrator threw — cancelling invoice',
      );
      try { await this.deps.holdInvoiceService.cancel(job.hold_invoice_payment_hash); } catch { /* swallow */ }
      await this.deps.fulfillJobRepo.setHoldInvoiceState(job.job_id, 'cancelled');
      return await this.abort(job.job_id, attempts, 'orchestrator_exception');
    }
  }

  /** Phase 4 — preview the cost of a fulfill without executing it. Pure
   *  read on intentService + computePremium. Does NOT verify token_balance
   *  (the agent may quote without prepaying), does NOT consume rate-limit
   *  tokens at the controller level (separate budget). The reserve_sats_max
   *  is what an agent should ensure is available before submitting fulfill. */
  async quote(req: { intent: IntentRequest; max_sats: number }): Promise<QuoteResult> {
    const intentResp = await this.deps.intentService.resolveIntent(req.intent, undefined);
    const top = intentResp.candidates.slice(0, MAX_CANDIDATES);
    const candidates: QuoteCandidate[] = top.map(c => {
      const invoice = c.price_sats ?? 0;
      const premium = computePremium(Math.max(1, invoice), c);
      return {
        rank: c.rank,
        endpoint_url: c.endpoint_url,
        operator_pubkey: c.operator_pubkey,
        invoice_sats_estimate: invoice,
        premium_estimate: premium,
        total_estimate: invoice + premium,
        p_e2e: c.stage_posteriors?.p_e2e ?? null,
        p_e2e_pessimistic: c.stage_posteriors?.p_e2e_pessimistic ?? null,
        median_latency_ms: c.median_latency_ms,
      };
    });
    const reserve = Math.min(
      req.max_sats + PREMIUM_FLOOR_SATS,
      candidates.reduce((acc, c) => acc + c.total_estimate, 0) || PREMIUM_FLOOR_SATS,
    );
    let circuitOpen = false;
    if (this.deps.poolAccounting) {
      const pool = await this.deps.poolAccounting.getBalance();
      circuitOpen = pool.circuit_breaker_open;
    }
    return {
      candidates,
      reserve_sats_max: reserve,
      circuit_breaker_open: circuitOpen,
    };
  }

  /** Audit C1 (2026-05-01) — repay a credit-line borrow when a fulfill exits
   *  on a failure path. Without this the deficit-covering loan sticks
   *  permanently in `borrowed_sats`, eventually trapping the agent under
   *  their own credit ceiling. Non-fatal: log and continue if the repay
   *  query itself fails (the agent's success path will retry). */
  private async repayBorrowOnFailure(agentPubkey: string, creditBorrowed: number): Promise<void> {
    if (creditBorrowed <= 0 || !this.deps.agentCreditRepo) return;
    try {
      await this.deps.agentCreditRepo.repay(agentPubkey, creditBorrowed, this.now());
    } catch (err) {
      logger.error(
        { agent_pubkey: agentPubkey.slice(0, 12), creditBorrowed, error: err instanceof Error ? err.message : String(err) },
        'Fulfill: credit repay on failure path failed (non-fatal — debt sticks until next success)',
      );
    }
  }

  /** Phase 9.1 — race fetchSafeExternal probes on N candidates, return the
   *  index (within the input slice) of the first one that returned 402 with
   *  a parseable L402 challenge. Throws when none succeed. The promises
   *  not-yet-resolved are not cancelled (their fetches will complete and
   *  drop on the floor) ; AbortSignal.timeout caps each at deadline. */
  private async raceParallelProbe(
    cands: IntentCandidate[],
    deadlineMs: number,
  ): Promise<number> {
    const probes = cands.map((cand, idx) => (async () => {
      const remaining = Math.max(50, deadlineMs - Date.now());
      const url = cand.endpoint_url;
      const method = cand.http_method;
      const resp = await this.fetchImpl(url, {
        method,
        signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, remaining)),
        headers: {
          'User-Agent': 'SatRank-Fulfill/1.0',
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      if (resp.status !== 402) {
        throw new Error(`probe[${idx}] ${url} → ${resp.status}`);
      }
      const wwwAuth = resp.headers.get('www-authenticate');
      const challenge = parseL402Challenge(wwwAuth);
      if (!challenge) {
        throw new Error(`probe[${idx}] ${url} no_l402_challenge`);
      }
      // Best-effort body discard so the connection can be reused.
      try { await resp.body?.cancel(); } catch { /* ignore */ }
      return idx;
    })());
    // Promise.any returns the first fulfilled promise ; rejections are
    // ignored unless ALL reject (AggregateError, which we throw upward).
    return await Promise.any(probes);
  }

  private async attemptCandidate(
    cand: IntentCandidate,
    budgetSatsRemaining: number,
    schemaJson?: object,
    deadlineMs?: number,
    validators?: string[],
  ): Promise<FulfillAttempt> {
    const url = cand.endpoint_url;
    const method = cand.http_method;
    const ts_started = this.now();

    // Sim 9 Fix 2 (2026-05-01) — hard deadline enforcement. The orchestrator
    // passes an absolute deadlineMs; each I/O step uses the lesser of its
    // default timeout and the remaining budget. This stops a single slow
    // candidate from blowing through the agent's max_latency_ms.
    //
    // remainingMs() returns the budget left (or default fetch timeout when
    // no deadline was passed). Always returns a positive integer so
    // AbortSignal.timeout never gets 0 (which fires immediately).
    const remainingMs = (defaultMs: number): number => {
      if (deadlineMs == null) return defaultMs;
      const left = deadlineMs - Date.now();
      return Math.max(50, Math.min(defaultMs, left));
    };

    // Step 1 — challenge fetch. Same shape as paidProbeRunner.probeOne so
    // we get identical SSRF + timeout + content-type semantics.
    let firstResp: Response;
    try {
      firstResp = await this.fetchImpl(url, {
        method,
        signal: AbortSignal.timeout(remainingMs(FETCH_TIMEOUT_MS)),
        headers: {
          'User-Agent': 'SatRank-Fulfill/1.0',
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return baseAttempt(cand, ts_started, this.now(), {
        payment_outcome: err instanceof SsrfBlockedError ? 'ssrf_blocked' : 'probe_no_response',
        delivery_outcome: 'delivery_skipped',
        http_status: null,
        sats_paid: 0,
        detail,
      });
    }

    if (firstResp.status !== 402) {
      return baseAttempt(cand, ts_started, this.now(), {
        payment_outcome: 'probe_not_402',
        delivery_outcome: 'delivery_skipped',
        http_status: firstResp.status,
        sats_paid: 0,
      });
    }

    const wwwAuth = firstResp.headers.get('www-authenticate');
    const challenge = parseL402Challenge(wwwAuth);
    if (!challenge) {
      return baseAttempt(cand, ts_started, this.now(), {
        payment_outcome: 'no_l402_challenge',
        delivery_outcome: 'delivery_skipped',
        http_status: 402,
        sats_paid: 0,
      });
    }

    // Step 2 — decode invoice + cost guards.
    let amountSats = 0;
    let payeeNodeKey: string | null = null;
    let invoicePaymentHash = '';
    try {
      const parsed = parseBolt11(challenge.invoice);
      amountSats = parsed.amountSats ?? 0;
      payeeNodeKey = parsed.payeeNodeKey;
      invoicePaymentHash = parsed.paymentHash;
    } catch (err) {
      return baseAttempt(cand, ts_started, this.now(), {
        payment_outcome: 'invoice_decode_failed',
        delivery_outcome: 'delivery_skipped',
        http_status: 402,
        sats_paid: 0,
        detail: err instanceof InvalidBolt11Error ? err.message : String(err),
      });
    }
    // Self-pay guard.
    if (
      payeeNodeKey &&
      this.deps.selfPubkey &&
      payeeNodeKey.toLowerCase() === this.deps.selfPubkey.toLowerCase()
    ) {
      return baseAttempt(cand, ts_started, this.now(), {
        payment_outcome: 'skipped_self_pay',
        delivery_outcome: 'delivery_skipped',
        http_status: 402,
        sats_paid: 0,
      });
    }
    if (amountSats <= 0) {
      // Hostile zero-amount invoice (audit Finding 1, 2026-04-29).
      return baseAttempt(cand, ts_started, this.now(), {
        payment_outcome: 'invoice_decode_failed',
        delivery_outcome: 'delivery_skipped',
        http_status: 402,
        sats_paid: 0,
        detail: `invoice amount=${amountSats}`,
      });
    }
    if (amountSats > budgetSatsRemaining) {
      return baseAttempt(cand, ts_started, this.now(), {
        payment_outcome: 'over_remaining_budget',
        delivery_outcome: 'delivery_skipped',
        http_status: 402,
        sats_paid: 0,
        detail: `invoice=${amountSats} > remaining=${budgetSatsRemaining}`,
      });
    }

    // Step 3 — pay. Mirrors paidProbeRunner's pattern: gate on the optional
    // `payInvoice` method rather than a separate isConfigured() check, so a
    // node where the admin macaroon failed to load (no payInvoice exposed)
    // gets a clean lnd_not_configured outcome instead of a runtime crash.
    //
    // Smoke E2E (2026-05-01) discovered: destructuring `payInvoice` loses
    // its `this` binding to HttpLndGraphClient, which uses `this.adminMacaroonHex`
    // internally. Call directly via `this.deps.lndClient.payInvoice(...)` so
    // `this` resolves correctly at runtime. Unit tests didn't catch it
    // because the mock impl doesn't depend on `this`.
    if (!this.deps.lndClient.payInvoice) {
      return baseAttempt(cand, ts_started, this.now(), {
        payment_outcome: 'lnd_not_configured',
        delivery_outcome: 'delivery_skipped',
        http_status: 402,
        sats_paid: 0,
      });
    }
    // Sim 9 Fix 2 — bound payInvoice timeout to remaining budget too.
    const paySec = Math.max(1, Math.ceil(remainingMs(PAY_TIMEOUT_DEFAULT_SEC * 1000) / 1000));
    const pay = await this.deps.lndClient.payInvoice(challenge.invoice, 10, paySec);
    if (pay.paymentError || !pay.paymentPreimage) {
      const detail = pay.paymentError ?? 'no preimage returned';
      const isRouting = /no.?route|no_route|FAILURE_REASON_NO_ROUTE|insufficient/i.test(detail);
      return baseAttempt(cand, ts_started, this.now(), {
        payment_outcome: isRouting ? 'pay_routing_failed' : 'pay_other_failure',
        delivery_outcome: 'delivery_skipped',
        http_status: 402,
        sats_paid: 0,
        detail,
      });
    }

    // Defense-in-depth: SHA256(preimage) === invoice.payment_hash. LND should
    // already enforce this; we re-check before trusting the preimage as
    // delivery proof (audit Tier 2H, project_security_audit_20260430.md).
    const computedPh = createHash('sha256')
      .update(Buffer.from(pay.paymentPreimage, 'hex'))
      .digest('hex')
      .toLowerCase();
    if (computedPh !== invoicePaymentHash.toLowerCase()) {
      logger.error(
        { url, computed: computedPh.slice(0, 16), expected: invoicePaymentHash.slice(0, 16) },
        'Fulfill: preimage hash mismatch — refusing pay_ok',
      );
      return baseAttempt(cand, ts_started, this.now(), {
        payment_outcome: 'preimage_hash_mismatch',
        delivery_outcome: 'delivery_skipped',
        http_status: 402,
        sats_paid: 0,
      });
    }

    // Step 4 — recall with L402 token. Sim 9 Fix 2 — bounded by remaining budget.
    const token = `L402 ${challenge.macaroon}:${pay.paymentPreimage}`;
    let recallResp: Response;
    try {
      recallResp = await this.fetchImpl(url, {
        method,
        signal: AbortSignal.timeout(remainingMs(FETCH_TIMEOUT_MS)),
        headers: {
          'User-Agent': 'SatRank-Fulfill/1.0',
          Authorization: token,
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
    } catch (err) {
      return baseAttempt(cand, ts_started, this.now(), {
        payment_outcome: 'pay_ok',
        delivery_outcome: 'recall_network_error',
        http_status: 402,
        sats_paid: amountSats,
        preimage: pay.paymentPreimage,
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const status = recallResp.status;
    const contentType = recallResp.headers.get('content-type');

    // Audit Phase 6.1 (2026-05-01): wrap the entire post-pay body processing
    // in a try-catch that returns an attempt rather than throwing. Otherwise
    // a malformed response stream / quality heuristic crash leaves the
    // orchestrator with a paid operator but no recorded attempt — the
    // refund_engine misses the absorbed-sats ledger record AND the for-loop
    // can't continue to the next candidate because the outer try-catch
    // fires. Smoke E2E surfaced this when readBodyCapped threw on a real
    // L402 candidate's response.
    // Sim 9 Fix 2 follow-up — readBodyCapped does NOT honor AbortSignal on
    // its stream loop, so a slow/stuck upstream body hangs forever. Race the
    // body read against the deadline; on timeout abort the response and
    // record a recall_body_timeout attempt. Stuck-in-flight jobs caught by
    // the reconciliation cron at 180s+ age are exactly this scenario.
    let body: string;
    let truncated: boolean;
    try {
      const readBodyMs = remainingMs(FETCH_TIMEOUT_MS);
      const read = await Promise.race([
        readBodyCapped(recallResp, RECALL_BODY_MAX_BYTES),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            // Cancel the underlying stream so resources are freed.
            try { recallResp.body?.cancel().catch(() => { /* ignore */ }); } catch { /* ignore */ }
            reject(new Error(`readBodyCapped timeout after ${readBodyMs}ms (deadline)`));
          }, readBodyMs).unref();
        }),
      ]);
      body = read.body.toString('utf8');
      truncated = read.truncated;
    } catch (err) {
      return baseAttempt(cand, ts_started, this.now(), {
        payment_outcome: 'pay_ok',
        delivery_outcome: 'recall_body_read_error',
        http_status: status,
        sats_paid: amountSats,
        preimage: pay.paymentPreimage,
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    let delivery: string;
    let validatorDetail: string | undefined;
    try {
      if (status >= 200 && status < 300) {
        delivery = body.length >= 10 ? 'delivery_ok' : 'delivery_empty_body';
        if (delivery === 'delivery_ok') {
          // Tier 2 light — heuristic body shape check. A 2xx that fails the
          // heuristics gets demoted to delivery_low_quality.
          const evaluated = evaluateBodyQuality({ body, contentType, status });
          if (!evaluated.passed) delivery = 'delivery_low_quality';
        }
        // Phase 3 — strict JSON Schema validation overlays the heuristics. If
        // the agent declared expected_schema_hash and the body parses + matches,
        // we promote/keep delivery_ok. Otherwise schema_violation classification
        // (Tier 2, disputable). Schema overrides heuristics — explicit > implicit.
        // Phase 7.4 — agent-supplied validator DSL is layered with schema check.
        // Both run if both supplied. Schema failure → delivery_schema_violation
        // (Tier 2). Validator DSL failure → delivery_validator_violation (5x
        // multiplier in ClaimEngine — punitive because operator violated an
        // explicit declared contract).
        if (delivery === 'delivery_ok' && (schemaJson || (validators && validators.length > 0))) {
          try {
            const chain = buildValidatorChain({ schema: schemaJson, validators });
            const result = validateAll(chain, { body, contentType, status });
            if (!result.passed) {
              // Phase 7.4 — distinguish schema violation (Tier 2 — operator
              // didn't match registered schema, semi-blame) from validator
              // DSL violation (operator violated an explicit agent contract,
              // 5x multiplier punitive). Failed validator name tells us which.
              const failedName = (result.details as { validator?: string } | undefined)?.validator ?? '';
              delivery = failedName.startsWith('json_schema')
                ? 'delivery_schema_violation'
                : 'delivery_validator_violation';
              validatorDetail = `${result.reason}: ${JSON.stringify(result.details ?? {})}`;
            }
          } catch (err) {
            logger.error(
              { error: err instanceof Error ? err.message : String(err) },
              'Fulfill: validator chain construction failed — accepting body without check',
            );
          }
        }
      } else if (status >= 400 && status < 500) {
        delivery = 'delivery_4xx';
      } else if (status >= 500 && status < 600) {
        delivery = 'delivery_5xx';
      } else {
        delivery = 'delivery_other';
      }
    } catch (err) {
      // evaluateBodyQuality / buildValidatorChain / validateAll may throw on
      // pathological bodies (binary content tagged as application/json,
      // gigantic JSON, etc.). Fail-soft: classify as delivery_classification_error
      // so the attempt is still recorded.
      return baseAttempt(cand, ts_started, this.now(), {
        payment_outcome: 'pay_ok',
        delivery_outcome: 'delivery_classification_error',
        http_status: status,
        sats_paid: amountSats,
        preimage: pay.paymentPreimage,
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // Phase 3 — when schema validation failed, prefer the validator detail
    // (machine-readable) over the body itself in the attempt.detail slot.
    // The successful body is only returned on delivery_ok, so we don't lose
    // information; on failure attempts[].detail surfaces the *reason*.
    const carryBody = delivery === 'delivery_ok';
    const detail = !carryBody && validatorDetail
      ? validatorDetail
      : truncated ? body + '\n[truncated_at_256kb]' : body;

    return baseAttempt(cand, ts_started, this.now(), {
      payment_outcome: 'pay_ok',
      delivery_outcome: delivery,
      http_status: status,
      sats_paid: amountSats,
      preimage: pay.paymentPreimage,
      // Carry the body in the `detail` slot so the orchestrator can return
      // it on success without a second fetch. Truncation is logged but the
      // first 256 KB is enough for any sensible API response.
      detail,
    });
  }

  /** Phase 6.1 — outbound residue refund. Returns the resulting refund_state.
   *  On transient failure marks 'pending'; on permanent failure (including
   *  decode error or LND error after retries) marks 'failed_absorbed'.
   *
   *  Single attempt here — the cron retries 'pending' on subsequent ticks.
   *  After RESIDUE_REFUND_MAX_ATTEMPTS the cron escalates to failed_absorbed
   *  so the residue stops blocking the queue. */
  private async payResidueRefund(
    jobId: string,
    refundBolt11: string,
    residueSats: number,
  ): Promise<'pending' | 'paid' | 'failed_absorbed'> {
    if (!this.deps.lndClient.payInvoice) {
      logger.warn({ jobId }, 'Residue refund: payInvoice unavailable — marking failed_absorbed');
      await this.deps.fulfillJobRepo.setRefundState({
        job_id: jobId,
        state: 'failed_absorbed',
        refund_amount_sats: residueSats,
        refund_last_error: 'lnd_payInvoice_unavailable',
        settled_at: this.now(),
      });
      return 'failed_absorbed';
    }
    let pay;
    try {
      // Direct call to preserve `this` binding to HttpLndGraphClient (smoke
      // E2E 2026-05-01 surfaced the unbound-method bug — see attemptCandidate).
      pay = await this.deps.lndClient.payInvoice(refundBolt11, 10, PAY_TIMEOUT_DEFAULT_SEC, residueSats);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ jobId, error: msg }, 'Residue refund: payInvoice threw — marking pending for cron retry');
      await this.deps.fulfillJobRepo.setRefundState({
        job_id: jobId,
        state: 'pending',
        refund_amount_sats: residueSats,
        refund_last_error: msg.slice(0, 200),
        increment_attempts: true,
      });
      return 'pending';
    }
    if (pay.paymentError || !pay.paymentPreimage) {
      const detail = pay.paymentError ?? 'no preimage returned';
      logger.warn({ jobId, error: detail }, 'Residue refund: payInvoice failed — marking pending');
      await this.deps.fulfillJobRepo.setRefundState({
        job_id: jobId,
        state: 'pending',
        refund_amount_sats: residueSats,
        refund_last_error: detail.slice(0, 200),
        increment_attempts: true,
      });
      return 'pending';
    }
    await this.deps.fulfillJobRepo.setRefundState({
      job_id: jobId,
      state: 'paid',
      refund_amount_sats: residueSats,
      refund_payment_preimage: pay.paymentPreimage,
      settled_at: this.now(),
    });
    return 'paid';
  }

  /** Phase 6.1 — cron entry point: retry one pending residue refund.
   *  Returns the resulting state so callers can log/tally outcomes. After
   *  RESIDUE_REFUND_MAX_ATTEMPTS attempts the residue is absorbed (becomes
   *  permanent revenue) and we surface failed_absorbed in /api/oracle/fulfill. */
  async retryPendingRefund(job: { job_id: string; refund_bolt11: string | null; refund_amount_sats: number | null; refund_attempts: number }): Promise<'pending' | 'paid' | 'failed_absorbed'> {
    if (job.refund_attempts >= RESIDUE_REFUND_MAX_ATTEMPTS) {
      await this.deps.fulfillJobRepo.setRefundState({
        job_id: job.job_id,
        state: 'failed_absorbed',
        refund_last_error: `exceeded ${RESIDUE_REFUND_MAX_ATTEMPTS} attempts`,
        settled_at: this.now(),
      });
      return 'failed_absorbed';
    }
    if (!job.refund_bolt11 || job.refund_amount_sats == null) {
      await this.deps.fulfillJobRepo.setRefundState({
        job_id: job.job_id,
        state: 'failed_absorbed',
        refund_last_error: 'no_refund_bolt11_or_amount',
        settled_at: this.now(),
      });
      return 'failed_absorbed';
    }
    return this.payResidueRefund(job.job_id, job.refund_bolt11, job.refund_amount_sats);
  }

  private async refund(
    jobId: string,
    attempts: FulfillAttempt[],
    reason: string,
  ): Promise<FulfillRefunded> {
    await this.deps.fulfillJobRepo.settleRefund({
      job_id: jobId,
      attempts,
      reason,
      settled_at: this.now(),
    });
    return { status: 'refunded', job_id: jobId, attempts, reason };
  }

  private async abort(
    jobId: string,
    attempts: FulfillAttempt[],
    reason: string,
  ): Promise<FulfillRefunded> {
    await this.deps.fulfillJobRepo.settleAbort({
      job_id: jobId,
      attempts,
      reason,
      settled_at: this.now(),
    });
    return { status: 'refunded', job_id: jobId, attempts, reason };
  }

  private skippedAttempt(cand: IntentCandidate, reason: string): FulfillAttempt {
    const t = this.now();
    return baseAttempt(cand, t, t, {
      payment_outcome: 'skipped_by_orchestrator',
      delivery_outcome: 'delivery_skipped',
      http_status: null,
      sats_paid: 0,
      detail: reason,
    });
  }

  /** Phase 2 — agent first-seen lookup for the daily cap age bucket. Returns
   *  the smallest `created_at` from token_balance for this agent's deposit
   *  rows; null when we have no record (treated as fresh agent → strict cap).
   *  The pubkey-to-deposit mapping is identical to fetchAgentBalance. */
  private async fetchAgentFirstSeen(agentPubkey: string): Promise<number | null> {
    const { rows } = await this.deps.pool.query<{ first_seen: string | null }>(
      `SELECT MIN(created_at)::text AS first_seen
         FROM token_balance
        WHERE payment_hash = $1`,
      [agentPubkey],
    );
    const v = rows[0]?.first_seen;
    return v == null ? null : Number(v);
  }

  /** Reads token_balance.balance_credits + remaining for an agent identified
   *  by their L402-tier deposit (any payment_hash they own). The agent_pubkey
   *  → payment_hash mapping lives in the deposit table; in V1 we treat
   *  agent_pubkey as the deposit owner key and aggregate. */
  private async fetchAgentBalance(agentPubkey: string): Promise<number> {
    // V1 simplification: token_balance has no agent_pubkey column today; we
    // assume the controller resolved the agent's deposit row(s) before
    // calling fulfill(). For the in-process custodial mode we accept a
    // sentinel (agent_pubkey = payment_hash). The /api/fulfill controller
    // will tighten this in Phase 1.4.
    const { rows } = await this.deps.pool.query<{ balance: string | null }>(
      `SELECT COALESCE(SUM(balance_credits * COALESCE(rate_sats_per_request, 1)), 0)::text AS balance
         FROM token_balance
        WHERE payment_hash = $1`,
      [agentPubkey],
    );
    return Number(rows[0]?.balance ?? 0);
  }

  private async debitAgentBalance(agentPubkey: string, sats: number): Promise<boolean> {
    // Atomic debit: condition the UPDATE on having enough balance.
    // V1 uses balance_credits; the rate is folded into the credits unit.
    const { rowCount } = await this.deps.pool.query(
      `UPDATE token_balance
          SET balance_credits = balance_credits - $2
        WHERE payment_hash = $1
          AND rate_sats_per_request IS NOT NULL
          AND balance_credits >= $2`,
      [agentPubkey, sats],
    );
    return (rowCount ?? 0) === 1;
  }
}

/** Phase 9.3 — cache TTL per category. Volatile categories get short TTL ;
 *  stable categories longer. Hard-cap 1 hour. Defaults to 5 min. */
function ttlForCategory(category: string): number {
  const c = category.toLowerCase();
  if (c.startsWith('bitcoin') || c.startsWith('crypto') || c.includes('price') || c.includes('exchange')) return 30;
  if (c.startsWith('data/finance') || c.startsWith('data/markets')) return 60;
  if (c.includes('news') || c.startsWith('search')) return 300;
  if (c.startsWith('data/government') || c.startsWith('data/legal')) return 1800;
  if (c.startsWith('ai')) return 600;  // LLM responses cached 10 min
  return 300;  // 5 min default
}

/** Premium formula. Floor 1 sat, scales 10% × invoice × (1 - p_e2e_pess). */
export function computePremium(invoiceSats: number, cand: IntentCandidate): number {
  const pPess = cand.stage_posteriors?.p_e2e_pessimistic ?? 0.5;
  const risk = 1 - Math.max(0, Math.min(1, pPess));
  const proportional = Math.ceil(invoiceSats * 0.10 * risk);
  return Math.max(PREMIUM_FLOOR_SATS, proportional);
}

/** Phase 4 — quote a fulfill without engagement. Resolves the intent,
 *  surfaces the top candidates with invoice estimates + premium estimates
 *  + the worst-case max_total agents should reserve. No external HTTP,
 *  no LND, no DB writes — pure read on the intentService output.
 *
 *  invoice_sats_estimate uses cand.price_sats (catalogue value). The actual
 *  invoice from the L402 challenge can differ; this is a hint, not a quote
 *  in the legal sense. We document the difference in the response. */
export interface QuoteCandidate {
  rank: number;
  endpoint_url: string;
  operator_pubkey: string | null;
  invoice_sats_estimate: number;
  premium_estimate: number;
  total_estimate: number;
  p_e2e: number | null;
  p_e2e_pessimistic: number | null;
  median_latency_ms: number | null;
}

export interface QuoteResult {
  candidates: QuoteCandidate[];
  /** Worst-case total the agent should reserve in token_balance to make
   *  this fulfill possible (sum of top-K invoice estimates capped at
   *  max_sats + worst-case premium for the highest-risk candidate). */
  reserve_sats_max: number;
  /** True when the quote ran with circuit_breaker_open=true. The /quote
   *  call still succeeds (it's read-only), but the agent should treat it
   *  as advisory: a fulfill submitted now will return 503. */
  circuit_breaker_open: boolean;
}

/** Stable sha256 of the resolved intent — used as the idempotency key. The
 *  hash is computed over the canonical-string form of (category, sorted
 *  keywords, budget_sats, max_latency_ms, optimize) so trivially-different
 *  shapes that mean the same thing don't bypass idempotency. */
export function canonicalIntentHash(intent: IntentRequest): string {
  const canon = [
    `c:${intent.category}`,
    `k:${(intent.keywords ?? []).slice().sort().join('|')}`,
    `b:${intent.budget_sats ?? ''}`,
    `l:${intent.max_latency_ms ?? ''}`,
    `o:${intent.optimize ?? 'p_success'}`,
  ].join(';');
  return createHash('sha256').update(canon).digest('hex');
}

function sha256OfBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function baseAttempt(
  cand: IntentCandidate,
  ts_started: number,
  ts_finished: number,
  rest: {
    payment_outcome: string;
    delivery_outcome: string;
    http_status: number | null;
    sats_paid: number;
    preimage?: string;
    detail?: string;
  },
): FulfillAttempt {
  return {
    candidate_url: cand.endpoint_url,
    rank: cand.rank,
    ts_started,
    ts_finished,
    operator_pubkey: cand.operator_pubkey,  // Phase 7.3 — for ClaimEngine bond resolution
    ...rest,
  };
}
