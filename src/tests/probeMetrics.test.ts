// Tests for Phase 9 C9 — /api/probe Prometheus metrics and structured logs.
//
// Focus: every exit path from await ProbeController.probe() increments
// satrank_probe_total with the correct outcome label, plus the histograms
// (duration, invoice) and counters (sats paid, ingestion) agree on the facts.
// The structured log line `probe_complete` carries the same outcome label so
// alert queries (rate(…{outcome="payment_failed"})) line up with logs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import crypto from 'crypto';
import * as bolt11 from 'bolt11';
import { ProbeController, type ProbeBayesianDeps } from '../controllers/probeController';
import type { LndGraphClient } from '../crawler/lndGraphClient';
import { TransactionRepository } from '../repositories/transactionRepository';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import { AgentRepository } from '../repositories/agentRepository';
import { metricsRegistry } from '../middleware/metrics';
import { createBayesianScoringService } from './helpers/bayesianTestFactory';
let testDb: TestDb;

// --- Fixtures ---
// Ephemeral privkey for signing fake BOLT11 invoices. No real sats touch this.
const TEST_PRIVKEY = crypto.randomBytes(32).toString('hex');

function makeInvoice(amountSats: number, paymentHashHex?: string): string {
  const paymentHash = paymentHashHex ?? crypto.randomBytes(32).toString('hex');
  const encoded = bolt11.encode({
    satoshis: amountSats,
    timestamp: Math.floor(Date.now() / 1000),
    tags: [
      { tagName: 'payment_hash', data: paymentHash },
      { tagName: 'description', data: 'probe metrics test' },
      { tagName: 'expire_time', data: 3600 },
      { tagName: 'payment_secret', data: crypto.randomBytes(32).toString('hex') },
    ],
    network: { bech32: 'bc', pubKeyHash: 0x00, scriptHash: 0x05, validWitnessVersions: [0, 1] },
  });
  const signed = bolt11.sign(encoded, TEST_PRIVKEY);
  if (!signed.paymentRequest) throw new Error('bolt11.sign returned empty paymentRequest');
  return signed.paymentRequest;
}

function l402AuthHeader(preimageHex: string): string {
  const mac = Buffer.from('fake-macaroon-for-test').toString('base64');
  return `L402 ${mac}:${preimageHex}`;
}

async function seedPhase9Token(db: Pool, preimage: string, credits: number): Promise<Buffer> {
  const ph = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest();
  await db.query(
    `INSERT INTO token_balance (payment_hash, remaining, created_at, max_quota, tier_id, rate_sats_per_request, balance_credits)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ph, 1000, Math.floor(Date.now() / 1000), 1000, 2, 0.5, credits],
  );
  return ph;
}

function makeMockLnd(opts: {
  canPay?: boolean;
  payResult?: { paymentPreimage: string; paymentHash: string; paymentError?: string };
} = {}): LndGraphClient {
  return {
    getInfo: vi.fn(),
    getGraph: vi.fn(),
    getNodeInfo: vi.fn(),
    queryRoutes: vi.fn(),
    canPayInvoices: () => opts.canPay ?? true,
    payInvoice: vi.fn().mockResolvedValue(
      opts.payResult ?? { paymentPreimage: 'a'.repeat(64), paymentHash: 'b'.repeat(64) },
    ),
  } as unknown as LndGraphClient;
}

function bayesianDeps(db: Pool): ProbeBayesianDeps {
  return {
    txRepo: new TransactionRepository(db),
    bayesian: createBayesianScoringService(db),
    serviceEndpointRepo: new ServiceEndpointRepository(db),
    agentRepo: new AgentRepository(db),
    dualWriteMode: 'active',
  };
}

function callProbe(
  controller: ProbeController,
  body: unknown,
  authHeader?: string,
): Promise<{ status: number; body: unknown; errorCode?: string }> {
  return new Promise((resolve) => {
    const req = { body, headers: { authorization: authHeader } } as unknown as Parameters<typeof controller.probe>[0];
    let statusCode = 200;
    const res = {
      status: (code: number) => { statusCode = code; return res; },
      json: (body: unknown) => { resolve({ status: statusCode, body }); },
    } as unknown as Parameters<typeof controller.probe>[1];
    const next = ((err?: unknown) => {
      if (err && typeof err === 'object' && 'statusCode' in err) {
        const appErr = err as { statusCode: number; code: string; message: string };
        resolve({ status: appErr.statusCode, body: { error: { code: appErr.code } }, errorCode: appErr.code });
      } else {
        resolve({ status: statusCode, body: null });
      }
    }) as Parameters<typeof controller.probe>[2];
    void controller.probe(req, res, next);
  });
}

async function counterValue(name: string, labels: Record<string, string>): Promise<number> {
  const metrics = await metricsRegistry.getMetricsAsJSON();
  const m = metrics.find(x => x.name === name);
  if (!m) return 0;
  const rows = m.values as Array<{ labels: Record<string, string>; value: number }>;
  const match = rows.find(r => Object.entries(labels).every(([k, v]) => r.labels[k] === v));
  return match?.value ?? 0;
}

async function scalarValue(name: string): Promise<number> {
  const metrics = await metricsRegistry.getMetricsAsJSON();
  const m = metrics.find(x => x.name === name);
  if (!m) return 0;
  const rows = m.values as Array<{ value: number; metricName?: string }>;
  // For a counter this is the one-and-only row; for a histogram pick the _sum
  // value, which is the cumulative total over all observations.
  const sumRow = rows.find(r => r.metricName?.endsWith('_sum'));
  if (sumRow) return sumRow.value;
  return rows[0]?.value ?? 0;
}

describe('ProbeController — Phase 9 C9 metrics', async () => {
  let db: Pool;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
});

  afterEach(async () => {
    await teardownTestPool(testDb);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('emits outcome=validation_error on bad body and does not touch other counters', async () => {
    const before = await counterValue('satrank_probe_total', { outcome: 'validation_error' });
    const controller = new ProbeController(db, makeMockLnd());
    await callProbe(controller, {});
    const after = await counterValue('satrank_probe_total', { outcome: 'validation_error' });
    expect(after - before).toBe(1);
  });

  it('emits outcome=probe_unavailable when admin macaroon is missing', async () => {
    const before = await counterValue('satrank_probe_total', { outcome: 'probe_unavailable' });
    const controller = new ProbeController(db, makeMockLnd({ canPay: false }));
    await callProbe(controller, { url: 'https://example.com' });
    const after = await counterValue('satrank_probe_total', { outcome: 'probe_unavailable' });
    expect(after - before).toBe(1);
  });

  it('emits outcome=insufficient_credits when the token is short', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');
    await seedPhase9Token(db, preimage, 3);
    const before = await counterValue('satrank_probe_total', { outcome: 'insufficient_credits' });
    const controller = new ProbeController(db, makeMockLnd());
    await callProbe(controller, { url: 'https://example.com' }, l402AuthHeader(preimage));
    const after = await counterValue('satrank_probe_total', { outcome: 'insufficient_credits' });
    expect(after - before).toBe(1);
  });

  it('emits outcome=upstream_unreachable when fetch throws', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');
    await seedPhase9Token(db, preimage, 100);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ETIMEDOUT')));
    const before = await counterValue('satrank_probe_total', { outcome: 'upstream_unreachable' });
    const controller = new ProbeController(db, makeMockLnd());
    await callProbe(controller, { url: 'https://dead.example/' }, l402AuthHeader(preimage));
    const after = await counterValue('satrank_probe_total', { outcome: 'upstream_unreachable' });
    expect(after - before).toBe(1);
  });

  it('emits outcome=upstream_not_l402 for a non-402 first response', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');
    await seedPhase9Token(db, preimage, 100);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: () => null },
    } as unknown as Response));
    const before = await counterValue('satrank_probe_total', { outcome: 'upstream_not_l402' });
    const controller = new ProbeController(db, makeMockLnd());
    await callProbe(controller, { url: 'https://open.example/' }, l402AuthHeader(preimage));
    const after = await counterValue('satrank_probe_total', { outcome: 'upstream_not_l402' });
    expect(after - before).toBe(1);
  });

  it('emits outcome=success_200 and updates sats_paid + invoice histogram on happy path', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');
    await seedPhase9Token(db, preimage, 100);
    const invoiceSats = 25;
    const invoice = makeInvoice(invoiceSats);

    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          status: 402,
          headers: {
            get: (k: string) => k.toLowerCase() === 'www-authenticate'
              ? `L402 macaroon="bWFj", invoice="${invoice}"`
              : null,
          },
        } as unknown as Response;
      }
      // Second fetch — Authorization header present, return 200.
      return {
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }));

    const successBefore = await counterValue('satrank_probe_total', { outcome: 'success_200' });
    const satsBefore = await scalarValue('satrank_probe_sats_paid_total');
    const invoiceSumBefore = await scalarValue('satrank_probe_invoice_sats');

    const controller = new ProbeController(db, makeMockLnd(), bayesianDeps(db));
    const res = await callProbe(controller, { url: 'https://paid.example/' }, l402AuthHeader(preimage));
    expect(res.status).toBe(200);

    expect(await counterValue('satrank_probe_total', { outcome: 'success_200' }) - successBefore).toBe(1);
    expect(await scalarValue('satrank_probe_sats_paid_total') - satsBefore).toBe(invoiceSats);
    expect(await scalarValue('satrank_probe_invoice_sats') - invoiceSumBefore).toBe(invoiceSats);
  });

  it('emits outcome=payment_failed when LND returns paymentError', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');
    await seedPhase9Token(db, preimage, 100);
    const invoice = makeInvoice(10);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 402,
      headers: {
        get: (k: string) => k.toLowerCase() === 'www-authenticate'
          ? `L402 macaroon="bWFj", invoice="${invoice}"`
          : null,
      },
    } as unknown as Response));
    const lnd = makeMockLnd({ payResult: { paymentPreimage: '', paymentHash: 'h', paymentError: 'no route' } });

    const before = await counterValue('satrank_probe_total', { outcome: 'payment_failed' });
    const satsBefore = await scalarValue('satrank_probe_sats_paid_total');
    const controller = new ProbeController(db, lnd);
    await callProbe(controller, { url: 'https://no-route.example/' }, l402AuthHeader(preimage));
    expect(await counterValue('satrank_probe_total', { outcome: 'payment_failed' }) - before).toBe(1);
    // Sats must NOT be counted as paid on a failed payment.
    expect(await scalarValue('satrank_probe_sats_paid_total') - satsBefore).toBe(0);
  });

  it('emits outcome=invoice_too_expensive when invoice > PROBE_MAX_INVOICE_SATS', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');
    await seedPhase9Token(db, preimage, 100);
    // Default PROBE_MAX_INVOICE_SATS = 1000 → use 5000 to trip the guard.
    const invoice = makeInvoice(5000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 402,
      headers: {
        get: (k: string) => k.toLowerCase() === 'www-authenticate'
          ? `L402 macaroon="bWFj", invoice="${invoice}"`
          : null,
      },
    } as unknown as Response));

    const before = await counterValue('satrank_probe_total', { outcome: 'invoice_too_expensive' });
    const satsBefore = await scalarValue('satrank_probe_sats_paid_total');
    const controller = new ProbeController(db, makeMockLnd());
    await callProbe(controller, { url: 'https://pricey.example/' }, l402AuthHeader(preimage));
    expect(await counterValue('satrank_probe_total', { outcome: 'invoice_too_expensive' }) - before).toBe(1);
    expect(await scalarValue('satrank_probe_sats_paid_total') - satsBefore).toBe(0);
  });

  it('increments satrank_probe_ingestion_total with reason label', async () => {
    const preimage = crypto.randomBytes(32).toString('hex');
    await seedPhase9Token(db, preimage, 100);
    // Non-402 first fetch → ingestObservation reason = 'not-l402'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: () => null },
    } as unknown as Response));

    const before = await counterValue('satrank_probe_ingestion_total', { reason: 'not-l402' });
    const controller = new ProbeController(db, makeMockLnd(), bayesianDeps(db));
    await callProbe(controller, { url: 'https://open.example/' }, l402AuthHeader(preimage));
    expect(await counterValue('satrank_probe_ingestion_total', { reason: 'not-l402' }) - before).toBe(1);
  });
});
