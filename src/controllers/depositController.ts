// Deposit controller — variable-amount L402 token purchase
// Bypasses Aperture: Express generates the invoice directly via LND,
// the agent pays, verifies, and gets a deposit token usable on all paid endpoints.
import crypto from 'crypto';
import { readFileSync } from 'fs';
import type { Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import { config } from '../config';
import { ValidationError } from '../errors';
import { logger } from '../logger';
import { depositPhaseTotal } from '../middleware/metrics';

const MIN_DEPOSIT_SATS = 21;
const MAX_DEPOSIT_SATS = 10_000;
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

export class DepositController {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

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
          res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Deposit invoice generation unavailable — LND_INVOICE_MACAROON_PATH not configured' } });
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

    const result = await lndAddInvoice(amount, `SatRank deposit: ${amount} requests`);

    // r_hash from LND is base64-encoded
    const rHashHex = Buffer.from(result.r_hash, 'base64').toString('hex');

    logger.info({ amount, rHashHex: rHashHex.slice(0, 16) }, 'Deposit invoice created');
    depositPhaseTotal.inc({ phase: 'invoice_created' });

    res.status(402).json({
      invoice: result.payment_request,
      paymentHash: rHashHex,
      amount,
      quotaGranted: amount, // 1 sat = 1 request
      expiresIn: INVOICE_EXPIRY_SEC,
      instructions: 'Pay the invoice, then call POST /api/deposit with { paymentHash, preimage } to activate your balance. Use Authorization: L402 deposit:<preimage> on paid endpoints.',
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

    // Verify preimage → payment_hash
    const computedHash = crypto.createHash('sha256').update(Buffer.from(body.preimage, 'hex')).digest('hex');
    if (computedHash !== body.paymentHash) {
      throw new ValidationError('preimage does not match paymentHash (SHA256(preimage) != paymentHash)');
    }

    const paymentHashBuf = Buffer.from(body.paymentHash, 'hex');

    // Atomic check-and-insert in a transaction to prevent race conditions.
    // Two concurrent requests with the same paymentHash: only the first credits,
    // the second gets alreadyRedeemed instead of a duplicate success.
    const checkAndInsert = this.db.transaction((quota: number) => {
      const existing = this.db.prepare('SELECT remaining FROM token_balance WHERE payment_hash = ?')
        .get(paymentHashBuf) as { remaining: number } | undefined;
      if (existing) return { alreadyRedeemed: true, balance: existing.remaining };

      const now = Math.floor(Date.now() / 1000);
      this.db.prepare('INSERT INTO token_balance (payment_hash, remaining, created_at) VALUES (?, ?, ?)')
        .run(paymentHashBuf, quota, now);
      return { alreadyRedeemed: false, balance: quota };
    });

    // Quick check outside transaction (avoids LND call for already-redeemed tokens)
    const preCheck = this.db.prepare('SELECT remaining FROM token_balance WHERE payment_hash = ?')
      .get(paymentHashBuf) as { remaining: number } | undefined;
    if (preCheck) {
      depositPhaseTotal.inc({ phase: 'verify_success_cached' });
      res.json({
        balance: preCheck.remaining,
        paymentHash: body.paymentHash,
        alreadyRedeemed: true,
        instructions: 'Use Authorization: L402 deposit:<preimage> on paid endpoints.',
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
    const result = checkAndInsert(quota);

    if (result.alreadyRedeemed) {
      // Race loser: the paymentHash was credited by a concurrent request between
      // our preCheck and checkAndInsert. Count distinctly so the cache/race path
      // rate can be compared to the fresh path.
      depositPhaseTotal.inc({ phase: 'verify_success_cached' });
      res.json({
        balance: result.balance,
        paymentHash: body.paymentHash,
        alreadyRedeemed: true,
        instructions: 'Use Authorization: L402 deposit:<preimage> on paid endpoints.',
      });
      return;
    }

    logger.info({ paymentHash: body.paymentHash.slice(0, 16), quota }, 'Deposit verified and balance credited');
    depositPhaseTotal.inc({ phase: 'verify_success_fresh' });

    res.status(201).json({
      balance: quota,
      paymentHash: body.paymentHash,
      token: `L402 deposit:${body.preimage}`,
      instructions: 'Use the token value as your Authorization header on all paid endpoints.',
    });
  }
}
