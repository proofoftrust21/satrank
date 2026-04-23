// Phase 14C follow-up — POST /api/deposit phase-1 surfacing of tier metadata.
// Goal: assert that the invoice response exposes the engraved tier (tierId),
// effective rate (rateSatsPerRequest) and display discount (discountPct) on
// representative amounts across the 5-tier schedule. Historical bug: the
// phase-1 response only echoed { invoice, paymentHash, amount, quotaGranted },
// forcing agents to fetch /api/deposit/tiers separately to price their
// deposit. Phase 14C aligned code/OpenAPI/landing/methodology on the tier
// schedule but left phase-1 silent — this spec defends the fix.
import { vi } from 'vitest';

// Must happen BEFORE the ESM import of DepositController, otherwise the
// module-level readFileSync(config.LND_INVOICE_MACAROON_PATH) runs with an
// undefined path and leaves invoiceMacaroonHex=null → handler returns 503.
// vi.hoisted() is specifically designed to run pre-import.
const { tmpMacaroonPath } = vi.hoisted(() => {
  const { mkdtempSync, writeFileSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'satrank-deposit-test-'));
  const path = join(dir, 'invoice.macaroon');
  writeFileSync(path, Buffer.from('aa'.repeat(32), 'hex'));
  process.env.LND_INVOICE_MACAROON_PATH = path;
  return { tmpMacaroonPath: path };
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import express from 'express';
import request from 'supertest';
import { DepositController } from '../controllers/depositController';
import { LndInvoiceService } from '../services/lndInvoiceService';
import { createV2Routes } from '../routes/v2';
import { errorHandler } from '../middleware/errorHandler';
import { requestIdMiddleware } from '../middleware/requestId';

let testDb: TestDb;

async function buildApp(): Promise<{ app: express.Express; db: Pool }> {
  testDb = await setupTestPool();
  const db = testDb.pool;
  const lndInvoice = new LndInvoiceService({
    restUrl: 'http://lnd.test',
    macaroonPath: tmpMacaroonPath,
  });
  const depositController = new DepositController(db, lndInvoice);
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  const stubV2 = {
    report: (_r: express.Request, res: express.Response) => res.sendStatus(204),
    profile: (_r: express.Request, res: express.Response) => res.sendStatus(204),
  } as unknown as import('../controllers/v2Controller').V2Controller;
  app.use('/api', createV2Routes(stubV2, undefined, undefined, depositController));
  app.use(errorHandler);
  return { app, db };
}

function mockLndAddInvoice(): void {
  // Return a deterministic r_hash + BOLT11 so the handler's hex conversion
  // and logging paths execute. The actual invoice string is opaque to the
  // tests — we never parse it back.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      r_hash: Buffer.alloc(32, 0x11).toString('base64'),
      payment_request: 'lnbc1pfaketestinvoice',
    }),
  }));
}

describe('POST /api/deposit phase-1 tier surfacing', async () => {
  let app: express.Express;

  beforeEach(async () => {
    const ctx = await buildApp();
    app = ctx.app;
    mockLndAddInvoice();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await teardownTestPool(testDb);
  });

  it('uses the tmp macaroon set by vi.hoisted (sanity)', () => {
    expect(process.env.LND_INVOICE_MACAROON_PATH).toBe(tmpMacaroonPath);
  });

  it('amount=21 → tierId=1, rateSatsPerRequest=1.0, discountPct=0', async () => {
    const res = await request(app).post('/api/deposit').send({ amount: 21 });
    expect(res.status).toBe(402);
    expect(res.body.data).toMatchObject({
      amount: 21,
      quotaGranted: 21,
      tierId: 1,
      rateSatsPerRequest: 1.0,
      discountPct: 0,
    });
    expect(res.body.data.invoice).toBe('lnbc1pfaketestinvoice');
    expect(res.body.data.paymentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('amount=100000 → tierId=4, rateSatsPerRequest=0.1, discountPct=90 + full OpenAPI contract', async () => {
    const res = await request(app).post('/api/deposit').send({ amount: 100000 });
    expect(res.status).toBe(402);
    expect(res.body.data).toMatchObject({
      amount: 100000,
      quotaGranted: 100000,
      tierId: 4,
      rateSatsPerRequest: 0.1,
      discountPct: 90,
    });
    // Defensive: OpenAPI DepositInvoiceResponse requires these 9 keys. A
    // refactor that drops one silently must break this test.
    const keys = Object.keys(res.body.data).sort();
    expect(keys).toEqual([
      'amount',
      'discountPct',
      'expiresIn',
      'instructions',
      'invoice',
      'paymentHash',
      'quotaGranted',
      'rateSatsPerRequest',
      'tierId',
    ]);
  });

  it('amount=1000000 → tierId=5, rateSatsPerRequest=0.05, discountPct=95', async () => {
    const res = await request(app).post('/api/deposit').send({ amount: 1000000 });
    expect(res.status).toBe(402);
    expect(res.body.data).toMatchObject({
      amount: 1000000,
      quotaGranted: 1000000,
      tierId: 5,
      rateSatsPerRequest: 0.05,
      discountPct: 95,
    });
  });
});
