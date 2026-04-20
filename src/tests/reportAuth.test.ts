// Sim #5 finding #7 — reportAuth must normalize a pubkey-form target to its
// hash form before looking up token_query_log (which stores hashed targets only).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import type express from 'express';
import { runMigrations } from '../database/migrations';
import { createReportAuth } from '../middleware/auth';
import { sha256 } from '../utils/crypto';

function makeL402Header(preimage: string): string {
  const fakeMac = Buffer.from('fake-macaroon-data').toString('base64');
  return `L402 ${fakeMac}:${preimage}`;
}

function paymentHashFromPreimage(preimage: string): Buffer {
  return crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest();
}

describe('reportAuth — target normalization', () => {
  let db: InstanceType<typeof Database>;
  let reportAuth: ReturnType<typeof createReportAuth>;

  const pubkey = '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f';
  const targetHash = sha256(pubkey); // identifier.ts normalization rule

  beforeAll(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    reportAuth = createReportAuth(db);
  });

  afterAll(() => db.close());

  function callMiddleware(authHeader: string, body: Record<string, unknown>): Promise<{ status: number; errorCode?: string }> {
    return new Promise((resolve) => {
      const req = { headers: { authorization: authHeader }, body } as express.Request;
      const res = {
        setHeader: () => {},
        status: () => ({ json: () => {} }),
      } as unknown as express.Response;
      const next = ((err?: unknown) => {
        if (err && typeof err === 'object' && 'statusCode' in err) {
          const appErr = err as { statusCode: number; code: string };
          resolve({ status: appErr.statusCode, errorCode: appErr.code });
        } else {
          resolve({ status: 200 });
        }
      }) as express.NextFunction;
      reportAuth(req, res, next);
    });
  }

  it('accepts a pubkey-form target when token_query_log has the hashed form', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');
    const paymentHash = paymentHashFromPreimage(preimage);

    // Seed: token_balance + token_query_log entry keyed on the HASH (as /decide stores it)
    db.prepare('INSERT INTO token_balance (payment_hash, remaining, created_at) VALUES (?, ?, ?)')
      .run(paymentHash, 20, Math.floor(Date.now() / 1000));
    db.prepare('INSERT INTO token_query_log (payment_hash, target_hash, decided_at) VALUES (?, ?, ?)')
      .run(paymentHash, targetHash, Math.floor(Date.now() / 1000));

    // Client submits with pubkey (66 chars, 03 prefix) — must be normalized to hash for lookup
    const result = await callMiddleware(makeL402Header(preimage), {
      target: pubkey,
      reporter: 'someone',
      outcome: 'success',
    });
    expect(result.status).toBe(200);
  });

  it('accepts a hash-form target as before (backward compat)', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');
    const paymentHash = paymentHashFromPreimage(preimage);

    db.prepare('INSERT INTO token_balance (payment_hash, remaining, created_at) VALUES (?, ?, ?)')
      .run(paymentHash, 20, Math.floor(Date.now() / 1000));
    db.prepare('INSERT INTO token_query_log (payment_hash, target_hash, decided_at) VALUES (?, ?, ?)')
      .run(paymentHash, targetHash, Math.floor(Date.now() / 1000));

    const result = await callMiddleware(makeL402Header(preimage), {
      target: targetHash, // 64-char hash
      reporter: 'someone',
      outcome: 'success',
    });
    expect(result.status).toBe(200);
  });

  it('rejects a pubkey-form target with UNAUTHORIZED when no token_query_log binding exists', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');
    const paymentHash = paymentHashFromPreimage(preimage);

    // Token exists but no token_query_log — never queried this target
    db.prepare('INSERT INTO token_balance (payment_hash, remaining, created_at) VALUES (?, ?, ?)')
      .run(paymentHash, 20, Math.floor(Date.now() / 1000));

    const result = await callMiddleware(makeL402Header(preimage), {
      target: pubkey,
      reporter: 'someone',
      outcome: 'success',
    });
    expect(result.status).toBe(401);
    expect(result.errorCode).toBe('UNAUTHORIZED');
  });

  it('rejects when target field is missing', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');
    const paymentHash = paymentHashFromPreimage(preimage);

    db.prepare('INSERT INTO token_balance (payment_hash, remaining, created_at) VALUES (?, ?, ?)')
      .run(paymentHash, 20, Math.floor(Date.now() / 1000));

    const result = await callMiddleware(makeL402Header(preimage), {
      reporter: 'someone',
      outcome: 'success',
    });
    expect(result.status).toBe(401);
  });
});
