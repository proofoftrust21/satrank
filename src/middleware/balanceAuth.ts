// L402 token balance middleware — quota system (21 requests per token)
// After apertureGateAuth verifies the L402 token is valid, this middleware
// tracks usage via a per-payment_hash counter in SQLite.
//
// Security note: the token balance IS the rate limit for paid endpoints.
// Each request costs 1 sat, making abuse economically self-limiting.
// IP-based rate limiting (express-rate-limit) provides the first layer;
// token balance provides the economic layer. IPv6 subnet rotation can
// bypass IP limits but cannot bypass token balance (attacker must pay).
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import { AppError } from '../errors';
import { logger } from '../logger';

const TOKEN_QUOTA = 21;

// HTTP status codes for which the balance decrement is refunded. Covers client
// input errors that short-circuit before any business logic runs: zod parse
// failures and body-parser rejections. 404/409 are NOT refunded because the
// server performed a lookup (real cost). 5xx are NOT refunded because an
// attacker could trigger them cheaply to keep their quota. See sim #5.
const REFUNDABLE_STATUS_CODES = new Set([400, 413]);

// Per-token refund rate limit. Without this, a paid token can issue unlimited
// malformed requests, get 400-refunded every time, and enjoy free service.
// Beyond MAX_REFUNDS_PER_WINDOW in REFUND_WINDOW_MS, refunds are suppressed.
const REFUND_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_REFUNDS_PER_WINDOW = 20;
const refundCounters = new Map<string, { count: number; windowStart: number }>();

function canRefund(paymentHashHex: string): boolean {
  const now = Date.now();
  const entry = refundCounters.get(paymentHashHex);
  if (!entry || now - entry.windowStart > REFUND_WINDOW_MS) {
    refundCounters.set(paymentHashHex, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= MAX_REFUNDS_PER_WINDOW) return false;
  entry.count++;
  return true;
}

// Periodic GC so the map doesn't grow unbounded across tokens. Runs every 10 min.
const REFUND_GC_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of refundCounters) {
    if (now - entry.windowStart > REFUND_WINDOW_MS) refundCounters.delete(key);
  }
}, REFUND_GC_INTERVAL_MS).unref();

class BalanceExhaustedError extends AppError {
  constructor(used: number, max: number) {
    super(
      `L402 token exhausted (${used}/${max} uses). Remove your Authorization header and retry to get a new invoice.`,
      402,
      'BALANCE_EXHAUSTED',
    );
    this.name = 'BalanceExhaustedError';
    (this as Record<string, unknown>).used = used;
    (this as Record<string, unknown>).max = max;
  }
}

// Distinct from BALANCE_EXHAUSTED so clients can tell "I need more sats" (pay
// the invoice or top up via deposit) from "this token was never registered"
// (the deposit flow wasn't completed or you hand-crafted a preimage). Sim #9
// FINDING #12 — "0/0 uses" BALANCE_EXHAUSTED was ambiguous for both cases.
class TokenUnknownError extends AppError {
  constructor() {
    super(
      'Deposit token not found. Call POST /api/deposit with { amount } first, pay the invoice, then POST /api/deposit with { paymentHash, preimage } to register the token.',
      402,
      'TOKEN_UNKNOWN',
    );
    this.name = 'TokenUnknownError';
  }
}

/** Extract the preimage from an L402/LSAT Authorization header.
 *  Format: "L402 <macaroon_base64>:<preimage_hex>" */
function extractPreimage(authHeader: string): string | null {
  const match = authHeader.match(/^(?:L402|LSAT)\s+\S+:([a-f0-9]{64})$/i);
  return match ? match[1] : null;
}

export function createBalanceAuth(db: Database.Database) {
  // Prepared statements for performance (reused across requests)
  const stmtDecrement = db.prepare(
    'UPDATE token_balance SET remaining = remaining - 1 WHERE payment_hash = ? AND remaining > 0',
  );
  const stmtGetBalance = db.prepare(
    'SELECT remaining FROM token_balance WHERE payment_hash = ?',
  );
  // Token lifetime quota ("max"). Deposit tokens start variable (21-10000);
  // Aperture tokens always start at TOKEN_QUOTA. Surfaced via
  // X-SatRank-Balance-Max so clients can render "remaining/max" without
  // guessing. Sim #9 FINDING #14.
  const stmtGetMax = db.prepare(
    'SELECT COALESCE(max_quota, remaining) AS max_quota FROM token_balance WHERE payment_hash = ?',
  );
  const stmtInsert = db.prepare(
    'INSERT OR IGNORE INTO token_balance (payment_hash, remaining, created_at, max_quota) VALUES (?, ?, ?, ?)',
  );
  const stmtRefund = db.prepare(
    'UPDATE token_balance SET remaining = remaining + 1 WHERE payment_hash = ?',
  );

  function scheduleRefund(res: Response, paymentHash: Buffer): void {
    let refunded = false;
    const paymentHashHex = paymentHash.toString('hex');
    res.on('finish', () => {
      if (refunded) return;
      if (!REFUNDABLE_STATUS_CODES.has(res.statusCode)) return;
      // Rate-limit refunds per token to prevent "free-ride via malformed body" abuse.
      if (!canRefund(paymentHashHex)) {
        logger.warn({ paymentHash: paymentHashHex.slice(0, 12), statusCode: res.statusCode }, 'refund suppressed (rate limit)');
        return;
      }
      refunded = true;
      try {
        stmtRefund.run(paymentHash);
      } catch (err) {
        logger.warn({ err, statusCode: res.statusCode }, 'balance refund failed');
      }
    });
  }

  return function balanceAuth(req: Request, res: Response, next: NextFunction): void {
    // Skip balance check for operator token (X-Aperture-Token path)
    // These requests bypass Aperture entirely — no L402 header present
    const authHeader = req.headers.authorization ?? '';
    if (!authHeader.startsWith('L402 ') && !authHeader.startsWith('LSAT ')) {
      // No L402 header = operator path or dev mode — skip balance
      next();
      return;
    }

    const preimage = extractPreimage(authHeader);
    if (!preimage) {
      next();
      return;
    }

    // payment_hash = SHA256(preimage) — standard Lightning identity
    const paymentHash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest();
    const now = Math.floor(Date.now() / 1000);

    // Try to decrement existing balance
    const result = stmtDecrement.run(paymentHash);
    if (result.changes > 0) {
      // Decrement succeeded — read remaining balance for header
      const row = stmtGetBalance.get(paymentHash) as { remaining: number } | undefined;
      const maxRow = stmtGetMax.get(paymentHash) as { max_quota: number } | undefined;
      res.setHeader('X-SatRank-Balance', String(row?.remaining ?? 0));
      if (maxRow?.max_quota) res.setHeader('X-SatRank-Balance-Max', String(maxRow.max_quota));
      scheduleRefund(res, paymentHash);
      next();
      return;
    }

    // Decrement failed — either token doesn't exist or remaining = 0
    const existing = stmtGetBalance.get(paymentHash) as { remaining: number } | undefined;

    if (existing) {
      // Token exists but remaining = 0 — exhausted
      const maxRow = stmtGetMax.get(paymentHash) as { max_quota: number } | undefined;
      res.setHeader('X-SatRank-Balance', '0');
      if (maxRow?.max_quota) res.setHeader('X-SatRank-Balance-Max', String(maxRow.max_quota));
      next(new BalanceExhaustedError(maxRow?.max_quota ?? TOKEN_QUOTA, maxRow?.max_quota ?? TOKEN_QUOTA));
      return;
    }

    // Deposit tokens must be pre-registered via POST /api/deposit verification.
    // Don't auto-create — prevents free-riding with fake deposit preimages.
    if (/^L402\s+deposit:/i.test(authHeader)) {
      res.setHeader('X-SatRank-Balance', '0');
      next(new TokenUnknownError());
      return;
    }

    // Aperture token — first use, create with remaining = quota - 1 (this request counts)
    stmtInsert.run(paymentHash, TOKEN_QUOTA - 1, now, TOKEN_QUOTA);
    res.setHeader('X-SatRank-Balance', String(TOKEN_QUOTA - 1));
    res.setHeader('X-SatRank-Balance-Max', String(TOKEN_QUOTA));
    scheduleRefund(res, paymentHash);
    next();
  };
}
