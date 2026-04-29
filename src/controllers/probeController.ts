// POST /api/probe — SatRank probes an L402 endpoint end-to-end on behalf of
// the caller. Flow: fetch → parse 402 L402 challenge → pay via SatRank's LND
// → retry with Authorization header → return telemetry.
//
// Accounting: /api/probe costs 5 credits per call. 1 credit is already
// decremented upstream by balanceAuth (uniform handler cost). This controller
// deducts the remaining 4 at the start, atomically — if the token can't
// cover it, we reject upfront rather than half-performing the probe.
//
// Safety rails:
//   - PROBE_MAX_INVOICE_SATS caps the invoice SatRank is willing to pay.
//     Prevents a malicious target from draining SatRank liquidity.
//   - PROBE_FETCH_TIMEOUT_MS bounds each HTTP round-trip.
//   - The admin macaroon (canPayInvoices) must be loaded; otherwise 503.
//
// Phase 9 C6 delivers the core fetch/parse/pay/retry flow. C7 layers on
// transaction dual-writes (source='paid') and streaming posterior updates
// at weight=2.0 — this controller exposes enough telemetry in its return
// shape for the C7 wiring to hang off of.

import crypto from 'crypto';
import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import type { LndGraphClient } from '../crawler/lndGraphClient';
import { config } from '../config';
import { logger } from '../logger';
import { ValidationError, AppError } from '../errors';
import { parseL402Challenge } from '../utils/l402HeaderParser';
import { parseBolt11, InvalidBolt11Error } from '../utils/bolt11Parser';
import type { TransactionRepository, DualWriteMode } from '../repositories/transactionRepository';
import type { BayesianScoringService } from '../services/bayesianScoringService';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { AgentRepository } from '../repositories/agentRepository';
import type { DualWriteEnrichment, DualWriteLogger } from '../utils/dualWriteLogger';
import { windowBucket } from '../utils/dualWriteLogger';
import { canonicalizeUrl, endpointHash } from '../utils/urlCanonical';
import { sha256 } from '../utils/crypto';
import { fetchSafeExternal, readBodyCapped, isUrlBlocked, SsrfBlockedError } from '../utils/ssrf';
import type { Transaction } from '../types';
import {
  probeTotal,
  probeSatsPaidTotal,
  probeIngestionTotal,
  probeDuration,
  probeInvoiceSats,
} from '../middleware/metrics';

/** Terminal outcome of performProbe — single source of truth for the
 *  `satrank_probe_total{outcome}` metric so we never disagree with what we
 *  just logged. Derived from a completed ProbeResult shape. */
function probeOutcome(result: ProbeResult): string {
  if (result.target === 'UNREACHABLE') return 'upstream_unreachable';
  if (result.target === 'NOT_L402') return 'upstream_not_l402';
  // target === 'L402' — now branch on what we actually did.
  if (!result.l402Challenge) return 'bolt11_invalid';
  if (result.payment?.paymentError?.startsWith('invoice amount')) return 'invoice_too_expensive';
  if (result.payment?.paymentError) return 'payment_failed';
  if (!result.payment) return 'payment_failed';
  if (result.secondFetch?.status === 200) return 'success_200';
  return 'success_non200';
}

// Total cost of one probe — 1 already taken by balanceAuth + 4 here.
const PROBE_COST_CREDITS = 5;
const PROBE_EXTRA_CREDITS = PROBE_COST_CREDITS - 1;

// F-07: cap response body to bound memory + keep preview honest. 64 KiB is
// well above any legitimate L402 JSON challenge or paid body.
const PROBE_MAX_BODY_BYTES = 64 * 1024;
// bodyPreview is kept textual; if the server answers with a binary
// Content-Type, we drop the preview to avoid leaking binary-encoded goo
// into an attacker-controlled JSON response.
const BINARY_CT_RE = /^(application\/(octet-stream|pdf|zip|x-(tar|gzip|bzip2|7z-compressed))|image\/|audio\/|video\/|font\/)/i;

const probeBodySchema = z.object({
  url: z.string().url('url must be a valid http(s) URL'),
});

class InsufficientCreditsError extends AppError {
  constructor() {
    super(
      `Insufficient credits — /api/probe costs ${PROBE_COST_CREDITS} credits per call. Top up via POST /api/deposit.`,
      402,
      'INSUFFICIENT_CREDITS',
    );
    this.name = 'InsufficientCreditsError';
  }
}

class ProbeUnavailableError extends AppError {
  constructor() {
    super(
      'Probe service unavailable — SatRank LND admin macaroon not configured. Retry later or contact support.',
      503,
      'PROBE_UNAVAILABLE',
    );
    this.name = 'ProbeUnavailableError';
  }
}

export interface ProbeResult {
  url: string;
  target: 'L402' | 'NOT_L402' | 'UNREACHABLE';
  firstFetch: {
    status: number | null;
    latencyMs: number;
    httpError?: string;
  };
  l402Challenge?: {
    macaroonLen: number;
    invoiceSats: number | null;
    invoicePaymentHash: string;
  };
  payment?: {
    paymentHash: string;
    preimage: string;
    paymentError?: string;
    durationMs: number;
  };
  secondFetch?: {
    status: number;
    latencyMs: number;
    bodyBytes: number;
    bodyHash: string;
    bodyPreview: string;
  };
  totalLatencyMs: number;
  cost: { creditsDeducted: number };
}

/** Optional bayesian ingestion dependencies for the paid probe. When present,
 *  a completed paid round-trip writes one `transactions` row (source='paid')
 *  and bumps the streaming posteriors with weight=2.0. Left optional so
 *  controller-only tests (fetch/parse/pay/retry) can still construct the
 *  class without standing up the full scoring stack. */
export interface ProbeBayesianDeps {
  txRepo: TransactionRepository;
  bayesian: BayesianScoringService;
  serviceEndpointRepo: ServiceEndpointRepository;
  agentRepo: AgentRepository;
  dualWriteMode: DualWriteMode;
  dualWriteLogger?: DualWriteLogger;
}

/** Shape returned by the ingestion helper so tests can assert exactly which
 *  side effects fired (tx insert, bayesian ingest) and for what reason the
 *  helper short-circuited when they didn't. */
export interface IngestionOutcome {
  ingested: boolean;
  reason: 'ingested' | 'no-deps' | 'not-l402' | 'no-payment' | 'endpoint-not-found'
        | 'endpoint-no-operator' | 'operator-agent-missing' | 'duplicate'
        | 'tx-write-failed';
  success?: boolean;
  txId?: string;
  endpointHash?: string;
  operatorId?: string;
}

export class ProbeController {
  private readonly pool: Pool;
  private readonly lndClient: LndGraphClient;
  private readonly bayesianDeps?: ProbeBayesianDeps;

  constructor(pool: Pool, lndClient: LndGraphClient, bayesianDeps?: ProbeBayesianDeps) {
    this.pool = pool;
    this.lndClient = lndClient;
    this.bayesianDeps = bayesianDeps;
  }

  probe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = probeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        probeTotal.inc({ outcome: 'validation_error' });
        throw new ValidationError(parsed.error.issues.map(i => i.message).join('; '));
      }

      // F-01: static SSRF pre-check before debiting credits. A DNS-rebinding
      // target that *resolves* to a private IP is still caught later by the
      // dispatcher's connect-time lookup inside performProbe.
      if (isUrlBlocked(parsed.data.url)) {
        probeTotal.inc({ outcome: 'url_blocked' });
        throw new ValidationError('URL_NOT_ALLOWED: target must be a public http(s) URL (no loopback, private, link-local, CGN, userinfo).');
      }

      if (!this.lndClient.canPayInvoices?.()) {
        probeTotal.inc({ outcome: 'probe_unavailable' });
        throw new ProbeUnavailableError();
      }

      // Extract paymentHash from the L402 header. balanceAuth already
      // validated the format — we just repeat the hash derivation.
      const auth = req.headers.authorization ?? '';
      const preimageMatch = /^(?:L402|LSAT)\s+\S+:([a-f0-9]{64})$/i.exec(auth);
      if (!preimageMatch) {
        probeTotal.inc({ outcome: 'validation_error' });
        throw new ValidationError('/api/probe requires an L402 deposit token in Authorization header');
      }
      const paymentHash = crypto.createHash('sha256').update(Buffer.from(preimageMatch[1], 'hex')).digest();

      // Deduct the remaining 4 credits atomically. rate_sats_per_request
      // IS NOT NULL guard ensures this only fires for Phase 9 tokens — a
      // legacy auto-created token should never reach /api/probe (which is a
      // paid endpoint). If the token is legacy or short on balance, the
      // UPDATE changes 0 rows → 402.
      const debitResult = await this.pool.query(
        `UPDATE token_balance
         SET balance_credits = balance_credits - $1
         WHERE payment_hash = $2
           AND rate_sats_per_request IS NOT NULL
           AND balance_credits >= $3`,
        [PROBE_EXTRA_CREDITS, paymentHash, PROBE_EXTRA_CREDITS],
      );
      if ((debitResult.rowCount ?? 0) === 0) {
        probeTotal.inc({ outcome: 'insufficient_credits' });
        throw new InsufficientCreditsError();
      }

      const result = await this.performProbe(parsed.data.url);

      // Emit outcome counters + sats paid before ingestion — observability
      // should be recorded even if ingestion throws on a downstream bug.
      const outcome = probeOutcome(result);
      probeTotal.inc({ outcome });
      probeDuration.observe(result.totalLatencyMs / 1000);
      if (result.l402Challenge?.invoiceSats !== null && result.l402Challenge?.invoiceSats !== undefined) {
        probeInvoiceSats.observe(result.l402Challenge.invoiceSats);
      }
      // Only count sats as paid if LND confirmed the preimage.
      if (result.payment?.preimage && !result.payment.paymentError && result.l402Challenge?.invoiceSats) {
        probeSatsPaidTotal.inc(result.l402Challenge.invoiceSats);
      }

      // Bayesian integration — only when deps are wired AND the endpoint is a
      // known L402 service. Failures never bubble up to the caller: a probe
      // observation is additive telemetry, not part of the response contract.
      try {
        const ingestion = await this.ingestObservation(parsed.data.url, result);
        probeIngestionTotal.inc({ reason: ingestion.reason });
      } catch (err) {
        probeIngestionTotal.inc({ reason: 'tx-write-failed' });
        logger.error({
          url: parsed.data.url,
          err: err instanceof Error ? err.message : String(err),
        }, 'paid probe ingestion unexpectedly threw');
      }

      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  };

  /** Write a tx (source='paid') and bump streaming posteriors with weight=2.0.
   *  Short-circuits early when the endpoint is unknown or the operator
   *  reference is dangling. Called from the handler on every probe (success
   *  OR failure on a known L402 endpoint) so the Bayesian layer sees both
   *  positive and negative signals. Exposed for tests. */
  async ingestObservation(url: string, result: ProbeResult): Promise<IngestionOutcome> {
    if (!this.bayesianDeps) return { ingested: false, reason: 'no-deps' };
    if (result.target !== 'L402') return { ingested: false, reason: 'not-l402' };
    if (!result.payment) return { ingested: false, reason: 'no-payment' };

    const { txRepo, bayesian, serviceEndpointRepo, agentRepo, dualWriteMode, dualWriteLogger } = this.bayesianDeps;

    // Lookup prefers the canonical form (RFC 3986 normalized) so two URLs
    // that differ only in casing/trailing-slash collapse onto the same row.
    // Falls back to the raw URL for compatibility with ad_hoc entries that
    // may have been stored pre-canonicalization.
    let canonUrl: string;
    try {
      canonUrl = canonicalizeUrl(url);
    } catch {
      canonUrl = url;
    }
    const endpoint = (await serviceEndpointRepo.findByUrl(canonUrl)) ?? (await serviceEndpointRepo.findByUrl(url));
    if (!endpoint) return { ingested: false, reason: 'endpoint-not-found' };
    if (!endpoint.agent_hash) return { ingested: false, reason: 'endpoint-no-operator' };
    if (!(await agentRepo.findByHash(endpoint.agent_hash))) {
      return { ingested: false, reason: 'operator-agent-missing' };
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const bucket = windowBucket(timestamp);
    const endpHash = endpointHash(url);
    // Daily-granularity idempotence: overlapping probes in the same 6h
    // bucket for the same endpoint collapse onto a single row.
    const txId = sha256(`paid:${endpHash}:${bucket}`);
    if (await txRepo.findById(txId)) return { ingested: false, reason: 'duplicate' };

    const success = result.secondFetch?.status === 200;
    const tx: Transaction = {
      tx_id: txId,
      sender_hash: endpoint.agent_hash,
      receiver_hash: endpoint.agent_hash,
      amount_bucket: 'micro',
      timestamp,
      payment_hash: result.payment.paymentHash || sha256(`${txId}:ph`),
      preimage: null,
      status: success ? 'verified' : 'failed',
      protocol: 'l402',
    };

    const enrichment: DualWriteEnrichment = {
      endpoint_hash: endpHash,
      operator_id: endpoint.agent_hash,
      source: 'paid',
      window_bucket: bucket,
    };

    try {
      await txRepo.insertWithDualWrite(tx, enrichment, dualWriteMode, 'probeController', dualWriteLogger);
    } catch (err) {
      logger.error({
        url, txId, err: err instanceof Error ? err.message : String(err),
      }, 'paid probe tx write failed');
      return { ingested: false, reason: 'tx-write-failed', success, txId, endpointHash: endpHash, operatorId: endpoint.agent_hash };
    }

    await bayesian.ingestStreaming({
      success,
      timestamp,
      source: 'paid',
      endpointHash: endpHash,
      operatorId: endpoint.agent_hash,
      nodePubkey: endpoint.agent_hash,
    });

    logger.info({
      url, txId, success, endpointHash: endpHash, operatorId: endpoint.agent_hash,
    }, 'paid probe observation ingested');

    return { ingested: true, reason: 'ingested', success, txId, endpointHash: endpHash, operatorId: endpoint.agent_hash };
  }

  /** The core probe pipeline, separated from the controller handler so it
   *  can be unit-tested without Express. */
  async performProbe(url: string): Promise<ProbeResult> {
    const t0 = Date.now();
    const result: ProbeResult = {
      url,
      target: 'UNREACHABLE',
      firstFetch: { status: null, latencyMs: 0 },
      totalLatencyMs: 0,
      cost: { creditsDeducted: PROBE_COST_CREDITS },
    };

    // Audit r3 — derive HTTP method from the catalogue when the URL is known.
    // POST-only endpoints (llm402.ai, etc) return 405 on GET; without this
    // lookup the user pays 5 sats and gets a confusing UNREACHABLE result on
    // a perfectly working endpoint.
    let probeMethod: 'GET' | 'POST' = 'GET';
    if (this.bayesianDeps) {
      try {
        const ep = (await this.bayesianDeps.serviceEndpointRepo.findByUrl(url));
        if (ep?.http_method === 'POST') probeMethod = 'POST';
      } catch { /* fail open: stay on GET */ }
    }

    // --- Step 1: first fetch ---
    const firstStart = Date.now();
    let firstResponse: Response | globalThis.Response | null = null;
    try {
      firstResponse = await fetchSafeExternal(url, {
        method: probeMethod,
        signal: AbortSignal.timeout(config.PROBE_FETCH_TIMEOUT_MS),
        headers: probeMethod === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        ...(probeMethod === 'POST' ? { body: '{}' } : {}),
      });
      result.firstFetch.latencyMs = Date.now() - firstStart;
      result.firstFetch.status = firstResponse.status;
    } catch (err: unknown) {
      result.firstFetch.latencyMs = Date.now() - firstStart;
      if (err instanceof SsrfBlockedError) {
        result.firstFetch.httpError = 'URL_NOT_ALLOWED';
      } else {
        result.firstFetch.httpError = err instanceof Error ? err.message : String(err);
      }
      result.totalLatencyMs = Date.now() - t0;
      return result;
    }

    // --- Step 2: detect L402 challenge ---
    // redirect: 'manual' means 3xx never follow. An L402 challenge is a 402,
    // so a 3xx from the target is not an L402 flow — treat as NOT_L402.
    if (firstResponse.status !== 402) {
      result.target = 'NOT_L402';
      result.totalLatencyMs = Date.now() - t0;
      return result;
    }

    const wwwAuth = firstResponse.headers.get('www-authenticate');
    const challenge = parseL402Challenge(wwwAuth);
    if (!challenge) {
      result.target = 'NOT_L402'; // 402 but not an L402 scheme
      result.totalLatencyMs = Date.now() - t0;
      return result;
    }

    // --- Step 3: parse invoice ---
    let bolt11;
    try {
      bolt11 = parseBolt11(challenge.invoice);
    } catch (err: unknown) {
      result.target = 'L402';
      result.firstFetch.httpError = err instanceof InvalidBolt11Error ? `invalid BOLT11: ${err.message}` : String(err);
      result.totalLatencyMs = Date.now() - t0;
      return result;
    }

    result.target = 'L402';
    result.l402Challenge = {
      macaroonLen: challenge.macaroon.length,
      invoiceSats: bolt11.amountSats,
      invoicePaymentHash: bolt11.paymentHash,
    };

    // --- Step 4: invoice safety rail ---
    if (bolt11.amountSats !== null && bolt11.amountSats > config.PROBE_MAX_INVOICE_SATS) {
      result.payment = {
        paymentHash: bolt11.paymentHash,
        preimage: '',
        paymentError: `invoice amount ${bolt11.amountSats} sats exceeds PROBE_MAX_INVOICE_SATS=${config.PROBE_MAX_INVOICE_SATS}`,
        durationMs: 0,
      };
      result.totalLatencyMs = Date.now() - t0;
      return result;
    }

    // --- Step 5: pay invoice via SatRank LND ---
    const payStart = Date.now();
    const pay = await this.lndClient.payInvoice!(challenge.invoice, 50); // 50 sat fee limit
    result.payment = {
      paymentHash: pay.paymentHash,
      preimage: pay.paymentPreimage,
      durationMs: Date.now() - payStart,
    };
    if (pay.paymentError || !pay.paymentPreimage) {
      result.payment.paymentError = pay.paymentError ?? 'empty preimage from LND';
      result.totalLatencyMs = Date.now() - t0;
      return result;
    }

    // --- Step 6: retry with L402 Authorization header ---
    const authHeader = `L402 ${challenge.macaroon}:${pay.paymentPreimage}`;
    const secondStart = Date.now();
    try {
      const secondResponse = await fetchSafeExternal(url, {
        method: probeMethod,
        headers: {
          Authorization: authHeader,
          ...(probeMethod === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(config.PROBE_FETCH_TIMEOUT_MS),
        ...(probeMethod === 'POST' ? { body: '{}' } : {}),
      });
      // F-07: cap the read, detect binary Content-Type, and never echo binary
      // bytes as a decoded "preview" string — a malicious target could craft a
      // payload that looks meaningful when decoded as UTF-8.
      const { body, truncated, capturedBytes } = await readBodyCapped(secondResponse, PROBE_MAX_BODY_BYTES);
      const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
      const contentType = secondResponse.headers.get('content-type') ?? '';
      const isBinary = BINARY_CT_RE.test(contentType);
      const preview = isBinary
        ? ''
        : body.subarray(0, 256).toString('utf8').replace(/[\x00-\x1f\x7f]/g, '.');
      result.secondFetch = {
        status: secondResponse.status,
        latencyMs: Date.now() - secondStart,
        bodyBytes: capturedBytes + (truncated ? 0 : 0),
        bodyHash,
        bodyPreview: preview,
      };
    } catch (err: unknown) {
      const errMsg = err instanceof SsrfBlockedError
        ? 'URL_NOT_ALLOWED'
        : err instanceof Error ? err.message : String(err);
      result.secondFetch = {
        status: 0,
        latencyMs: Date.now() - secondStart,
        bodyBytes: 0,
        bodyHash: '',
        bodyPreview: `retry failed: ${errMsg}`,
      };
    }

    result.totalLatencyMs = Date.now() - t0;
    logger.info({
      event: 'probe_complete',
      url,
      target: result.target,
      outcome: probeOutcome(result),
      firstStatus: result.firstFetch.status,
      firstLatencyMs: result.firstFetch.latencyMs,
      invoiceSats: result.l402Challenge?.invoiceSats ?? null,
      paymentHashPrefix: result.payment?.paymentHash?.slice(0, 12) ?? null,
      paidOk: !result.payment?.paymentError,
      paymentDurationMs: result.payment?.durationMs ?? null,
      secondStatus: result.secondFetch?.status ?? null,
      secondLatencyMs: result.secondFetch?.latencyMs ?? null,
      secondBodyBytes: result.secondFetch?.bodyBytes ?? null,
      totalMs: result.totalLatencyMs,
    }, 'probe complete');

    return result;
  }
}
