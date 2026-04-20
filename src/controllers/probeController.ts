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
import type Database from 'better-sqlite3';
import type { LndGraphClient } from '../crawler/lndGraphClient';
import { config } from '../config';
import { logger } from '../logger';
import { ValidationError, AppError } from '../errors';
import { parseL402Challenge } from '../utils/l402HeaderParser';
import { parseBolt11, InvalidBolt11Error } from '../utils/bolt11Parser';

// Total cost of one probe — 1 already taken by balanceAuth + 4 here.
const PROBE_COST_CREDITS = 5;
const PROBE_EXTRA_CREDITS = PROBE_COST_CREDITS - 1;

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

export class ProbeController {
  private readonly db: Database.Database;
  private readonly lndClient: LndGraphClient;

  /** Prepared statement for the extra 4-credit debit. rate_sats_per_request
   *  IS NOT NULL guard ensures this only fires for Phase 9 tokens — a
   *  legacy Aperture token should never reach /api/probe (which is a paid
   *  endpoint). */
  private readonly stmtDebit;

  constructor(db: Database.Database, lndClient: LndGraphClient) {
    this.db = db;
    this.lndClient = lndClient;
    this.stmtDebit = this.db.prepare(`
      UPDATE token_balance
      SET balance_credits = balance_credits - ?
      WHERE payment_hash = ?
        AND rate_sats_per_request IS NOT NULL
        AND balance_credits >= ?
    `);
  }

  probe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = probeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues.map(i => i.message).join('; '));
      }

      if (!this.lndClient.canPayInvoices?.()) {
        throw new ProbeUnavailableError();
      }

      // Extract paymentHash from the L402 header. balanceAuth already
      // validated the format — we just repeat the hash derivation.
      const auth = req.headers.authorization ?? '';
      const preimageMatch = /^(?:L402|LSAT)\s+\S+:([a-f0-9]{64})$/i.exec(auth);
      if (!preimageMatch) {
        throw new ValidationError('/api/probe requires an L402 deposit token in Authorization header');
      }
      const paymentHash = crypto.createHash('sha256').update(Buffer.from(preimageMatch[1], 'hex')).digest();

      // Deduct the remaining 4 credits atomically. If the token is legacy
      // or short on balance, the UPDATE changes 0 rows → 402.
      const debitResult = this.stmtDebit.run(PROBE_EXTRA_CREDITS, paymentHash, PROBE_EXTRA_CREDITS);
      if (debitResult.changes === 0) {
        throw new InsufficientCreditsError();
      }

      const result = await this.performProbe(parsed.data.url);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  };

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

    // --- Step 1: first fetch ---
    const firstStart = Date.now();
    let firstResponse: Response | globalThis.Response | null = null;
    try {
      firstResponse = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(config.PROBE_FETCH_TIMEOUT_MS),
      });
      result.firstFetch.latencyMs = Date.now() - firstStart;
      result.firstFetch.status = firstResponse.status;
    } catch (err: unknown) {
      result.firstFetch.latencyMs = Date.now() - firstStart;
      result.firstFetch.httpError = err instanceof Error ? err.message : String(err);
      result.totalLatencyMs = Date.now() - t0;
      return result;
    }

    // --- Step 2: detect L402 challenge ---
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
      const secondResponse = await fetch(url, {
        method: 'GET',
        headers: { Authorization: authHeader },
        signal: AbortSignal.timeout(config.PROBE_FETCH_TIMEOUT_MS),
      });
      const bodyBytes = await secondResponse.arrayBuffer();
      const body = Buffer.from(bodyBytes);
      const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
      const preview = body.subarray(0, 256).toString('utf8').replace(/[\x00-\x1f\x7f]/g, '.');
      result.secondFetch = {
        status: secondResponse.status,
        latencyMs: Date.now() - secondStart,
        bodyBytes: body.length,
        bodyHash,
        bodyPreview: preview,
      };
    } catch (err: unknown) {
      result.secondFetch = {
        status: 0,
        latencyMs: Date.now() - secondStart,
        bodyBytes: 0,
        bodyHash: '',
        bodyPreview: `retry failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    result.totalLatencyMs = Date.now() - t0;
    logger.info({
      url,
      target: result.target,
      firstStatus: result.firstFetch.status,
      invoiceSats: result.l402Challenge?.invoiceSats,
      paidOk: !result.payment?.paymentError,
      secondStatus: result.secondFetch?.status,
      totalMs: result.totalLatencyMs,
    }, 'probe complete');

    return result;
  }
}
