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
  const stmtInsert = db.prepare(
    'INSERT OR IGNORE INTO token_balance (payment_hash, remaining, created_at) VALUES (?, ?, ?)',
  );
  const stmtRefund = db.prepare(
    'UPDATE token_balance SET remaining = remaining + 1 WHERE payment_hash = ?',
  );

  function scheduleRefund(res: Response, paymentHash: Buffer): void {
    let refunded = false;
    res.on('finish', () => {
      if (refunded) return;
      if (!REFUNDABLE_STATUS_CODES.has(res.statusCode)) return;
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
      res.setHeader('X-SatRank-Balance', String(row?.remaining ?? 0));
      scheduleRefund(res, paymentHash);
      next();
      return;
    }

    // Decrement failed — either token doesn't exist or remaining = 0
    const existing = stmtGetBalance.get(paymentHash) as { remaining: number } | undefined;

    if (existing) {
      // Token exists but remaining = 0 — exhausted
      res.setHeader('X-SatRank-Balance', '0');
      next(new BalanceExhaustedError(TOKEN_QUOTA, TOKEN_QUOTA));
      return;
    }

    // Deposit tokens must be pre-registered via POST /api/deposit verification.
    // Don't auto-create — prevents free-riding with fake deposit preimages.
    if (/^L402\s+deposit:/i.test(authHeader)) {
      res.setHeader('X-SatRank-Balance', '0');
      next(new BalanceExhaustedError(0, 0));
      return;
    }

    // Aperture token — first use, create with remaining = quota - 1 (this request counts)
    stmtInsert.run(paymentHash, TOKEN_QUOTA - 1, now);
    res.setHeader('X-SatRank-Balance', String(TOKEN_QUOTA - 1));
    scheduleRefund(res, paymentHash);
    next();
  };
}
