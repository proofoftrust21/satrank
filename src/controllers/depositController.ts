// Deposit controller — variable-amount L402 token purchase
// Bypasses Aperture: Express generates the invoice directly via LND,
// the agent pays, verifies, and gets a deposit token usable on all paid endpoints.
import crypto from 'crypto';
import { readFileSync } from 'fs';
import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import { config } from '../config';
import { ValidationError } from '../errors';
import { logger } from '../logger';
import { depositPhaseTotal } from '../middleware/metrics';
import { DepositTierService } from '../services/depositTierService';
import { withTransaction } from '../database/transaction';

const MIN_DEPOSIT_SATS = 21;
const MAX_DEPOSIT_SATS = 1_000_000;
const INVOICE_EXPIRY_SEC = 600; // 10 minutes

// Load invoice macaroon at startup (separate from the readonly one)
let invoiceMacaroonHex: string | null = null;
if (config.LND_INVOICE_MACAROON_PATH) {
  try {
    invoiceMacaroonHex = readFileSync(config.LND_INVOICE_MACAROON_PATH).toString('hex');
    logger.info({ path: config.LND_INVOICE_MACAROON_PATH }, 'Invoice macaroon loaded for /api/deposit');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg }, 'Failed to load invoice macaroon — /api/deposit will be unavailable');
  }
}

async function lndAddInvoice(valueSat: number, memo: string): Promise<{ r_hash: string; payment_request: string }> {
  const resp = await fetch(`${config.LND_REST_URL}/v1/invoices`, {
    method: 'POST',
    headers: { 'Grpc-Metadata-macaroon': invoiceMacaroonHex!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: String(valueSat), memo, expiry: String(INVOICE_EXPIRY_SEC) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LND addInvoice failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  return resp.json() as Promise<{ r_hash: string; payment_request: string }>;
}

async function lndLookupInvoice(rHashHex: string): Promise<{ settled: boolean; value: string; memo: string }> {
  // LND REST /v1/invoice/{r_hash_str} expects hex-encoded hash
  const resp = await fetch(`${config.LND_REST_URL}/v1/invoice/${rHashHex}`, {
    headers: { 'Grpc-Metadata-macaroon': invoiceMacaroonHex! },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LND lookupInvoice failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  return resp.json() as Promise<{ settled: boolean; value: string; memo: string }>;
}

interface TokenBalanceRow {
  remaining: number;
  balance_credits: number;
  rate_sats_per_request: number | null;
  tier_id: number | null;
}

export class DepositController {
  private pool: Pool;
  private tierService: DepositTierService;

  constructor(pool: Pool) {
    this.pool = pool;
    this.tierService = new DepositTierService(pool);
  }

  /** GET /api/deposit/tiers — public schedule, no auth required.
   *  Agents use this to price their deposit before calling POST /api/deposit. */
  listTiers = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const tiers = await this.tierService.listTiers();
      res.json({
        data: {
          tiers: tiers.map(t => ({
            tierId: t.tier_id,
            minDepositSats: t.min_deposit_sats,
            rateSatsPerRequest: t.rate_sats_per_request,
            discountPct: t.discount_pct,
            requestsPerDeposit: t.min_deposit_sats / t.rate_sats_per_request,
          })),
          currency: 'sats',
          rateUnit: 'sats per request',
          notes: [
            'Rate is engraved on the token at creation; future schedule changes do not affect existing deposits.',
            'A deposit below the tier-1 floor (21 sats) is rejected with NO_APPLICABLE_TIER.',
            'requestsPerDeposit shows how many regular requests a deposit exactly at that tier floor would buy.',
          ],
        },
      });
    } catch (err) {
      next(err);
    }
  };

  /** Two-phase deposit:
   *  Phase 1: { amount: N } → returns 402 with BOLT11 invoice
   *  Phase 2: { paymentHash: "...", preimage: "..." } → verifies payment, creates balance */
  deposit = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as Record<string, unknown>;

      // Phase 2: verify payment and create balance
      // verifyDeposit only needs the macaroon if it has to call LND lookupInvoice
      // (i.e. when the payment_hash is not yet in the local token_balance table).
      // Already-redeemed tokens can be verified without LND access.
      if (body.paymentHash && body.preimage) {
        await this.verifyDeposit(req, res);
        return;
      }

      // Phase 1: create invoice — always needs LND
      if (body.amount) {
        if (!invoiceMacaroonHex) {
          res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Deposit invoice generation unavailable (LND_INVOICE_MACAROON_PATH not configured)' } });
          return;
        }
        await this.createInvoice(req, res);
        return;
      }

      throw new ValidationError('Request must include either { amount } (phase 1) or { paymentHash, preimage } (phase 2)');
    } catch (err) {
      next(err);
    }
  };

  private async createInvoice(_req: Request, res: Response): Promise<void> {
    const body = _req.body as { amount: unknown };
    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount < MIN_DEPOSIT_SATS || amount > MAX_DEPOSIT_SATS) {
      throw new ValidationError(`amount must be an integer between ${MIN_DEPOSIT_SATS} and ${MAX_DEPOSIT_SATS}`);
    }

    const tier = await this.tierService.lookupTierForAmount(amount);
    if (!tier) {
      throw new ValidationError(`No deposit tier matches amount ${amount}`);
    }

    const result = await lndAddInvoice(amount, `SatRank deposit: ${amount} requests`);

    const rHashHex = Buffer.from(result.r_hash, 'base64').toString('hex');

    logger.info({ amount, tierId: tier.tier_id, rHashHex: rHashHex.slice(0, 16) }, 'Deposit invoice created');
    depositPhaseTotal.inc({ phase: 'invoice_created' });

    res.status(402).json({
      data: {
        invoice: result.payment_request,
        paymentHash: rHashHex,
        amount,
        quotaGranted: amount,
        tierId: tier.tier_id,
        rateSatsPerRequest: tier.rate_sats_per_request,
        discountPct: tier.discount_pct,
        expiresIn: INVOICE_EXPIRY_SEC,
        instructions: 'Pay the invoice, then call POST /api/deposit with { paymentHash, preimage } to activate your balance. Use Authorization: L402 deposit:<preimage> on paid endpoints.',
      },
    });
  }

  private async verifyDeposit(req: Request, res: Response): Promise<void> {
    const body = req.body as { paymentHash: string; preimage: string };

    // Validate formats
    if (typeof body.paymentHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.paymentHash)) {
      throw new ValidationError('paymentHash must be a 64-char hex string');
    }
    if (typeof body.preimage !== 'string' || !/^[a-f0-9]{64}$/.test(body.preimage)) {
      throw new ValidationError('preimage must be a 64-char hex string');
    }

    // Verify preimage → payment_hash in constant time (timing oracle avoidance).
    const computedHashBuf = crypto.createHash('sha256').update(Buffer.from(body.preimage, 'hex')).digest();
    const paymentHashBuf = Buffer.from(body.paymentHash, 'hex');
    if (
      computedHashBuf.length !== paymentHashBuf.length ||
      !crypto.timingSafeEqual(computedHashBuf, paymentHashBuf)
    ) {
      throw new ValidationError('preimage does not match paymentHash (SHA256(preimage) != paymentHash)');
    }

    // Quick check outside transaction (avoids LND call for already-redeemed tokens)
    const preCheckResult = await this.pool.query<TokenBalanceRow>(
      'SELECT remaining, balance_credits, rate_sats_per_request, tier_id FROM token_balance WHERE payment_hash = $1',
      [paymentHashBuf],
    );
    const preCheck = preCheckResult.rows[0];
    if (preCheck) {
      depositPhaseTotal.inc({ phase: 'verify_success_cached' });
      res.json({
        data: {
          balance: preCheck.remaining,
          balanceCredits: preCheck.balance_credits,
          rateSatsPerRequest: preCheck.rate_sats_per_request,
          tierId: preCheck.tier_id,
          paymentHash: body.paymentHash,
          alreadyRedeemed: true,
          instructions: 'Use Authorization: L402 deposit:<preimage> on paid endpoints.',
        },
      });
      return;
    }

    // Beyond this point we need LND. If macaroon is missing, the paymentHash is
    // unknown to SatRank and we can't verify it.
    if (!invoiceMacaroonHex) {
      depositPhaseTotal.inc({ phase: 'verify_not_found' });
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'paymentHash not found in SatRank balance table. The deposit was either never created here or is awaiting verification (LND lookup unavailable).' },
        paymentHash: body.paymentHash,
      });
      return;
    }

    // Verify payment settled in LND
    const invoice = await lndLookupInvoice(body.paymentHash);

    if (!invoice.settled) {
      depositPhaseTotal.inc({ phase: 'verify_pending' });
      res.status(402).json({
        error: { code: 'PAYMENT_PENDING', message: 'Invoice not yet settled. Pay the invoice first, then retry.' },
        paymentHash: body.paymentHash,
      });
      return;
    }

    // Atomic credit — handles concurrent requests safely.
    // Audit H8: defend against malformed LND responses. If `value` is not a
    // finite positive integer, refuse to credit rather than insert a 0-balance
    // token (silent loss for the depositor) or a NaN row (DB-engine dependent).
    const quota = parseInt(invoice.value, 10);
    if (!Number.isFinite(quota) || quota <= 0) {
      logger.error({ paymentHash: body.paymentHash.slice(0, 16), rawValue: invoice.value }, 'Deposit: LND returned invalid invoice.value — refusing to credit');
      res.status(502).json({
        error: { code: 'UPSTREAM_INVALID', message: 'Lightning backend returned an invalid invoice value. Please retry; contact support if this persists.' },
        paymentHash: body.paymentHash,
      });
      return;
    }

    // Phase 9 — look up the engraved tier + compute credits. An amount below
    // the floor (< 21 sats) is guarded by createInvoice's MIN_DEPOSIT_SATS
    // check, but we defend again here in case a legacy invoice somehow slipped
    // through.
    const tier = await this.tierService.lookupTierForAmount(quota);
    if (!tier) {
      logger.error({ paymentHash: body.paymentHash.slice(0, 16), quota }, 'Deposit: no applicable tier — refusing to credit');
      res.status(502).json({
        error: { code: 'NO_APPLICABLE_TIER', message: 'Amount is below the minimum deposit tier. Retry with a deposit ≥ 21 sats.' },
        paymentHash: body.paymentHash,
      });
      return;
    }
    const credits = this.tierService.computeCredits(quota, tier);

    // Atomic check-and-insert in a transaction to prevent race conditions.
    // Two concurrent requests with the same paymentHash: only the first credits,
    // the second gets alreadyRedeemed instead of a duplicate success.
    //
    // Phase 9: engrave tier_id + rate_sats_per_request + balance_credits on the
    // row at INSERT. Rate is frozen for the lifetime of this token — future
    // schedule changes can't retroactively charge more.
    const result = await withTransaction(this.pool, async (client) => {
      const existingRes = await client.query<TokenBalanceRow>(
        'SELECT remaining, balance_credits, rate_sats_per_request, tier_id FROM token_balance WHERE payment_hash = $1',
        [paymentHashBuf],
      );
      const existing = existingRes.rows[0];
      if (existing) return { alreadyRedeemed: true as const, existing };

      const now = Math.floor(Date.now() / 1000);
      await client.query(
        `INSERT INTO token_balance (payment_hash, remaining, created_at, max_quota, tier_id, rate_sats_per_request, balance_credits)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [paymentHashBuf, quota, now, quota, tier.tier_id, tier.rate_sats_per_request, credits],
      );
      return { alreadyRedeemed: false as const };
    });

    if (result.alreadyRedeemed) {
      // Race loser: the paymentHash was credited by a concurrent request between
      // our preCheck and checkAndInsert. Count distinctly so the cache/race path
      // rate can be compared to the fresh path.
      depositPhaseTotal.inc({ phase: 'verify_success_cached' });
      res.json({
        data: {
          balance: result.existing.remaining,
          balanceCredits: result.existing.balance_credits,
          rateSatsPerRequest: result.existing.rate_sats_per_request,
          tierId: result.existing.tier_id,
          paymentHash: body.paymentHash,
          alreadyRedeemed: true,
          instructions: 'Use Authorization: L402 deposit:<preimage> on paid endpoints.',
        },
      });
      return;
    }

    logger.info({
      paymentHash: body.paymentHash.slice(0, 16),
      quota, tierId: tier.tier_id, rate: tier.rate_sats_per_request, credits,
    }, 'Deposit verified and balance credited');
    depositPhaseTotal.inc({ phase: 'verify_success_fresh' });

    res.status(201).json({
      data: {
        balance: quota,
        balanceCredits: credits,
        rateSatsPerRequest: tier.rate_sats_per_request,
        tierId: tier.tier_id,
        discountPct: tier.discount_pct,
        paymentHash: body.paymentHash,
        token: `L402 deposit:${body.preimage}`,
        instructions: 'Use the token value as your Authorization header on all paid endpoints.',
      },
    });
  }
}
