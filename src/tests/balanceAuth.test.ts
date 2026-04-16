import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import express from 'express';
import { runMigrations } from '../database/migrations';
import { createBalanceAuth } from '../middleware/balanceAuth';

function makeL402Header(preimage: string): string {
  // Fake macaroon (doesn't matter — balanceAuth only reads the preimage)
  const fakeMac = Buffer.from('fake-macaroon-data').toString('base64');
  return `L402 ${fakeMac}:${preimage}`;
}

function paymentHashFromPreimage(preimage: string): Buffer {
  return crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest();
}

describe('balanceAuth middleware', () => {
  let db: InstanceType<typeof Database>;
  let balanceAuth: ReturnType<typeof createBalanceAuth>;

  beforeAll(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    balanceAuth = createBalanceAuth(db);
  });

  afterAll(() => db.close());

  function callMiddleware(authHeader?: string): Promise<{ status: number; balance: string | null; errorCode?: string }> {
    return new Promise((resolve) => {
      const req = { headers: { authorization: authHeader } } as express.Request;
      let capturedBalance: string | null = null;
      const emitter = new EventEmitter();
      const res = Object.assign(emitter, {
        setHeader: (name: string, value: string) => {
          if (name === 'X-SatRank-Balance') capturedBalance = value;
        },
        status: (code: number) => ({
          json: (body: { error?: { code: string } }) => {
            resolve({ status: code, balance: capturedBalance, errorCode: body.error?.code });
          },
        }),
      }) as unknown as express.Response;
      const next = ((err?: unknown) => {
        if (err && typeof err === 'object' && 'statusCode' in err) {
          const appErr = err as { statusCode: number; code: string };
          resolve({ status: appErr.statusCode, balance: capturedBalance, errorCode: appErr.code });
        } else {
          resolve({ status: 200, balance: capturedBalance });
        }
      }) as express.NextFunction;
      balanceAuth(req, res, next);
    });
  }

  it('skips balance check when no Authorization header', async () => {
    const result = await callMiddleware(undefined);
    expect(result.status).toBe(200);
    expect(result.balance).toBeNull();
  });

  it('skips balance check for non-L402 Authorization', async () => {
    const result = await callMiddleware('Bearer abc123');
    expect(result.status).toBe(200);
    expect(result.balance).toBeNull();
  });

  it('creates token_balance on first use with remaining = 20', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');
    const result = await callMiddleware(makeL402Header(preimage));
    expect(result.status).toBe(200);
    expect(result.balance).toBe('20');

    // Verify DB
    const ph = paymentHashFromPreimage(preimage);
    const row = db.prepare('SELECT remaining FROM token_balance WHERE payment_hash = ?').get(ph) as { remaining: number };
    expect(row.remaining).toBe(20);
  });

  it('decrements remaining on each call', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');

    // First call: creates with 20
    const r1 = await callMiddleware(makeL402Header(preimage));
    expect(r1.balance).toBe('20');

    // Second call: 19
    const r2 = await callMiddleware(makeL402Header(preimage));
    expect(r2.balance).toBe('19');

    // Third call: 18
    const r3 = await callMiddleware(makeL402Header(preimage));
    expect(r3.balance).toBe('18');
  });

  it('allows exactly 21 calls then returns BALANCE_EXHAUSTED', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');

    // Use all 21 calls
    for (let i = 0; i < 21; i++) {
      const result = await callMiddleware(makeL402Header(preimage));
      expect(result.status).toBe(200);
      expect(result.balance).toBe(String(20 - i));
    }

    // 22nd call should be rejected
    const exhausted = await callMiddleware(makeL402Header(preimage));
    expect(exhausted.status).toBe(402);
    expect(exhausted.errorCode).toBe('BALANCE_EXHAUSTED');
    expect(exhausted.balance).toBe('0');
  });

  it('different preimages have independent balances', async () => {
    const preimage1 = crypto.randomBytes(32).toString('hex');
    const preimage2 = crypto.randomBytes(32).toString('hex');

    const r1 = await callMiddleware(makeL402Header(preimage1));
    expect(r1.balance).toBe('20');

    const r2 = await callMiddleware(makeL402Header(preimage2));
    expect(r2.balance).toBe('20');

    // Use preimage1 again — should be 19
    const r3 = await callMiddleware(makeL402Header(preimage1));
    expect(r3.balance).toBe('19');

    // preimage2 should still be 20... no wait, it was used once (r2), so 19
    // Actually let me re-check: first call creates with 20, second decrements to 19
    const r4 = await callMiddleware(makeL402Header(preimage2));
    expect(r4.balance).toBe('19');
  });

  // Refund behaviour — sim #5 finding #1. Client input errors (400/413)
  // should NOT drain the token; other statuses keep the decrement.
  function callAndEmitFinish(authHeader: string, finishStatus: number): Promise<{ balance: string | null }> {
    return new Promise((resolve) => {
      const emitter = new EventEmitter() as unknown as express.Response;
      let capturedBalance: string | null = null;
      const res = Object.assign(emitter, {
        statusCode: finishStatus,
        setHeader: (name: string, value: string) => {
          if (name === 'X-SatRank-Balance') capturedBalance = value;
        },
      }) as unknown as express.Response;
      const req = { headers: { authorization: authHeader } } as express.Request;
      const next = (() => {
        // Simulate Express flushing the response after the middleware chain runs
        (res as unknown as EventEmitter).emit('finish');
        resolve({ balance: capturedBalance });
      }) as express.NextFunction;
      balanceAuth(req, res, next);
    });
  }

  it('refunds the decrement on 400 VALIDATION_ERROR', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');

    // First call — creates with 20
    await callAndEmitFinish(makeL402Header(preimage), 200);

    // Second call ends with 400 — should be refunded
    await callAndEmitFinish(makeL402Header(preimage), 400);

    const ph = paymentHashFromPreimage(preimage);
    const row = db.prepare('SELECT remaining FROM token_balance WHERE payment_hash = ?').get(ph) as { remaining: number };
    expect(row.remaining).toBe(20); // Still 20 because the 400 was refunded
  });

  it('refunds the decrement on 413 PAYLOAD_TOO_LARGE', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');

    await callAndEmitFinish(makeL402Header(preimage), 200);
    await callAndEmitFinish(makeL402Header(preimage), 413);

    const ph = paymentHashFromPreimage(preimage);
    const row = db.prepare('SELECT remaining FROM token_balance WHERE payment_hash = ?').get(ph) as { remaining: number };
    expect(row.remaining).toBe(20);
  });

  it('does NOT refund on 200 OK (normal request)', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');

    await callAndEmitFinish(makeL402Header(preimage), 200);
    await callAndEmitFinish(makeL402Header(preimage), 200);

    const ph = paymentHashFromPreimage(preimage);
    const row = db.prepare('SELECT remaining FROM token_balance WHERE payment_hash = ?').get(ph) as { remaining: number };
    expect(row.remaining).toBe(19); // Decremented twice
  });

  it('does NOT refund on 404 NOT_FOUND — server did a real lookup', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');

    await callAndEmitFinish(makeL402Header(preimage), 200);
    await callAndEmitFinish(makeL402Header(preimage), 404);

    const ph = paymentHashFromPreimage(preimage);
    const row = db.prepare('SELECT remaining FROM token_balance WHERE payment_hash = ?').get(ph) as { remaining: number };
    expect(row.remaining).toBe(19);
  });

  it('does NOT refund on 409 CONFLICT — server did real business logic', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');

    await callAndEmitFinish(makeL402Header(preimage), 200);
    await callAndEmitFinish(makeL402Header(preimage), 409);

    const ph = paymentHashFromPreimage(preimage);
    const row = db.prepare('SELECT remaining FROM token_balance WHERE payment_hash = ?').get(ph) as { remaining: number };
    expect(row.remaining).toBe(19);
  });

  it('does NOT refund on 500 INTERNAL_ERROR — would be abuse vector', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');

    await callAndEmitFinish(makeL402Header(preimage), 200);
    await callAndEmitFinish(makeL402Header(preimage), 500);

    const ph = paymentHashFromPreimage(preimage);
    const row = db.prepare('SELECT remaining FROM token_balance WHERE payment_hash = ?').get(ph) as { remaining: number };
    expect(row.remaining).toBe(19);
  });

  it('refund is idempotent — multiple finish emits do not double-credit', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');

    // Step 1: create token (remaining=20, no decrement on first use)
    await callAndEmitFinish(makeL402Header(preimage), 200);

    // Step 2: decrement to 19, then emit 'finish' twice with a refundable status
    const emitter = new EventEmitter();
    const res = Object.assign(emitter, {
      statusCode: 400,
      setHeader: () => {},
    }) as unknown as express.Response;
    const req = { headers: { authorization: makeL402Header(preimage) } } as express.Request;
    await new Promise<void>((resolve) => balanceAuth(req, res, () => resolve()));

    (res as unknown as EventEmitter).emit('finish');
    (res as unknown as EventEmitter).emit('finish');

    const ph = paymentHashFromPreimage(preimage);
    const row = db.prepare('SELECT remaining FROM token_balance WHERE payment_hash = ?').get(ph) as { remaining: number };
    // 20 (created) -1 (decrement) +1 (refund once) = 20. A double-refund would give 21.
    expect(row.remaining).toBe(20);
  });

  it('handles concurrent requests atomically', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');

    // First call to create the entry
    await callMiddleware(makeL402Header(preimage));

    // Fire 10 concurrent calls
    const promises = Array.from({ length: 10 }, () => callMiddleware(makeL402Header(preimage)));
    const results = await Promise.all(promises);

    // All should succeed (we had 20 remaining after first call, now used 10 more = 10 remaining)
    const successes = results.filter(r => r.status === 200);
    expect(successes.length).toBe(10);

    // Verify DB has exactly 10 remaining
    const ph = paymentHashFromPreimage(preimage);
    const row = db.prepare('SELECT remaining FROM token_balance WHERE payment_hash = ?').get(ph) as { remaining: number };
    expect(row.remaining).toBe(10);
  });
});
