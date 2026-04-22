// @ts-nocheck — archived 2026-04-22 in Phase 12C (SQLite-era better-sqlite3 API, not ported to pg). See docs/phase-12c/TS-ERRORS-AUDIT.md.
// Tests for ProbeController Phase 9 C7 — Bayesian + transactions integration.
// Focuses on the ingestObservation() helper (short-circuit matrix) and end-to-
// end side effects visible in SQL after a successful paid probe flows through
// await controller.probe(): one transactions row with source='paid', one streaming
// posterior bump with weight=2.0, idempotence across repeated calls in the
// same 6h window bucket.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import crypto from 'crypto';
import * as bolt11 from 'bolt11';
import { ProbeController, type ProbeResult, type ProbeBayesianDeps } from '../controllers/probeController';
import type { LndGraphClient } from '../crawler/lndGraphClient';
import { TransactionRepository } from '../repositories/transactionRepository';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import { AgentRepository } from '../repositories/agentRepository';
import { sha256 } from '../utils/crypto';
import { endpointHash, canonicalizeUrl } from '../utils/urlCanonical';
import {
  EndpointStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import { createBayesianScoringService } from './helpers/bayesianTestFactory';
import { windowBucket } from '../utils/dualWriteLogger';
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
      { tagName: 'description', data: 'paid probe test' },
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

function seedAgent(db: Pool, hash: string, now: number): void {
  db.prepare(`
    INSERT OR IGNORE INTO agents (public_key_hash, first_seen, last_seen, source)
    VALUES (?, ?, ?, 'manual')
  `).run(hash, now - 86400, now);
}

function seedEndpoint(db: Pool, url: string, agentHash: string | null, now: number): void {
  db.prepare(`
    INSERT INTO service_endpoints (agent_hash, url, last_http_status, last_latency_ms, last_checked_at, check_count, success_count, created_at, source)
    VALUES (?, ?, 200, 50, ?, 1, 1, ?, '402index')
  `).run(agentHash, url, now, now);
}

function seedPhase9Token(db: Pool, preimage: string, credits: number): Buffer {
  const ph = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest();
  db.prepare(`
    INSERT INTO token_balance (payment_hash, remaining, created_at, max_quota, tier_id, rate_sats_per_request, balance_credits)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(ph, 1000, Math.floor(Date.now() / 1000), 1000, 2, 0.5, credits);
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

// TODO Phase 12B: describe uses helpers with SQLite .prepare/.run/.get/.all — port fixtures to pg before unskipping.
describe.skip('ProbeController — Phase 9 C7 Bayesian + tx integration', async () => {
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

  describe('ingestObservation — short-circuit matrix', () => {
    function mkResult(overrides: Partial<ProbeResult> = {}): ProbeResult {
      return {
        url: 'https://ok.example/probe',
        target: 'L402',
        firstFetch: { status: 402, latencyMs: 10 },
        l402Challenge: { macaroonLen: 40, invoiceSats: 10, invoicePaymentHash: 'd'.repeat(64) },
        payment: { paymentHash: 'e'.repeat(64), preimage: 'f'.repeat(64), durationMs: 100 },
        secondFetch: { status: 200, latencyMs: 20, bodyBytes: 11, bodyHash: 'x'.repeat(64), bodyPreview: 'hello probe' },
        totalLatencyMs: 130,
        cost: { creditsDeducted: 5 },
        ...overrides,
      };
    }

    it('returns reason="no-deps" when bayesianDeps not provided', async () => {
      const controller = new ProbeController(db, makeMockLnd());
      const outcome = controller.ingestObservation('https://ok.example/probe', mkResult());
      expect(outcome).toEqual({ ingested: false, reason: 'no-deps' });
    });

    it('returns reason="not-l402" when target is UNREACHABLE', async () => {
      const controller = new ProbeController(db, makeMockLnd(), bayesianDeps(db));
      const outcome = controller.ingestObservation('https://ok.example/probe', mkResult({
        target: 'UNREACHABLE',
        payment: undefined,
        secondFetch: undefined,
      }));
      expect(outcome.ingested).toBe(false);
      expect(outcome.reason).toBe('not-l402');
    });

    it('returns reason="not-l402" when target is NOT_L402', async () => {
      const controller = new ProbeController(db, makeMockLnd(), bayesianDeps(db));
      const outcome = controller.ingestObservation('https://ok.example/probe', mkResult({
        target: 'NOT_L402',
        payment: undefined,
        secondFetch: undefined,
      }));
      expect(outcome.reason).toBe('not-l402');
    });

    it('returns reason="no-payment" when target=L402 but payment never attempted', async () => {
      const controller = new ProbeController(db, makeMockLnd(), bayesianDeps(db));
      const outcome = controller.ingestObservation('https://ok.example/probe', mkResult({
        payment: undefined,
        secondFetch: undefined,
      }));
      expect(outcome.reason).toBe('no-payment');
    });

    it('returns reason="endpoint-not-found" when the URL is not in service_endpoints', async () => {
      const controller = new ProbeController(db, makeMockLnd(), bayesianDeps(db));
      const outcome = controller.ingestObservation('https://ghost.example/unknown', mkResult({
        url: 'https://ghost.example/unknown',
      }));
      expect(outcome.reason).toBe('endpoint-not-found');
    });

    it('returns reason="endpoint-no-operator" when endpoint.agent_hash is NULL', async () => {
      const now = Math.floor(Date.now() / 1000);
      const url = 'https://orphan.example/probe';
      seedEndpoint(db, canonicalizeUrl(url), null, now);
      const controller = new ProbeController(db, makeMockLnd(), bayesianDeps(db));
      const outcome = controller.ingestObservation(url, mkResult({ url }));
      expect(outcome.reason).toBe('endpoint-no-operator');
    });

    it('returns reason="operator-agent-missing" when endpoint.agent_hash is dangling', async () => {
      const now = Math.floor(Date.now() / 1000);
      const url = 'https://dangling.example/probe';
      const danglingHash = sha256('no-such-agent');
      seedEndpoint(db, canonicalizeUrl(url), danglingHash, now);
      const controller = new ProbeController(db, makeMockLnd(), bayesianDeps(db));
      const outcome = controller.ingestObservation(url, mkResult({ url }));
      expect(outcome.reason).toBe('operator-agent-missing');
    });
  });

  describe('ingestObservation — side effects', async () => {
    // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
    it.skip('writes tx (source=paid, status=verified) and bumps streaming posterior on success', async () => {
      const now = Math.floor(Date.now() / 1000);
      const url = 'https://paid.example/service';
      const agentHash = sha256('paid-op-1');
      seedAgent(db, agentHash, now);
      seedEndpoint(db, canonicalizeUrl(url), agentHash, now);

      const controller = new ProbeController(db, makeMockLnd(), bayesianDeps(db));
      const outcome = controller.ingestObservation(url, {
        url,
        target: 'L402',
        firstFetch: { status: 402, latencyMs: 10 },
        l402Challenge: { macaroonLen: 40, invoiceSats: 50, invoicePaymentHash: 'd'.repeat(64) },
        payment: { paymentHash: 'e'.repeat(64), preimage: 'f'.repeat(64), durationMs: 100 },
        secondFetch: { status: 200, latencyMs: 20, bodyBytes: 11, bodyHash: 'x'.repeat(64), bodyPreview: 'hello' },
        totalLatencyMs: 130,
        cost: { creditsDeducted: 5 },
      });

      expect(outcome.ingested).toBe(true);
      expect(outcome.success).toBe(true);
      expect(outcome.operatorId).toBe(agentHash);
      expect(outcome.endpointHash).toBe(endpointHash(url));

      const txRow = db.prepare(`
        SELECT tx_id, sender_hash, receiver_hash, status, source, endpoint_hash, operator_id, protocol, window_bucket
        FROM transactions WHERE source = 'paid'
      `).get() as {
        tx_id: string; sender_hash: string; receiver_hash: string; status: string;
        source: string; endpoint_hash: string; operator_id: string; protocol: string; window_bucket: string;
      };
      expect(txRow).toBeDefined();
      expect(txRow.source).toBe('paid');
      expect(txRow.status).toBe('verified');
      expect(txRow.protocol).toBe('l402');
      expect(txRow.sender_hash).toBe(agentHash);
      expect(txRow.receiver_hash).toBe(agentHash);
      expect(txRow.endpoint_hash).toBe(endpointHash(url));
      expect(txRow.operator_id).toBe(agentHash);
      expect(txRow.window_bucket).toMatch(/^\d{4}-\d{2}-\d{2}-\d{2}$/);

      // Streaming posterior: success with weight=2.0 → α bumps by ~2 above prior
      // (1.5 flat prior → α ≈ 3.5 immediately after ingestion).
      const repo = new EndpointStreamingPosteriorRepository(db);
      const dec = await repo.readDecayed(endpointHash(url), 'paid', now + 1);
      expect(dec.posteriorAlpha).toBeCloseTo(3.5, 1);
      expect(dec.posteriorBeta).toBeCloseTo(1.5, 1);
      expect(dec.totalIngestions).toBe(1);
    });

    // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
    it.skip('writes tx (status=failed) and bumps failure posterior on second-fetch non-200', async () => {
      const now = Math.floor(Date.now() / 1000);
      const url = 'https://broken.example/service';
      const agentHash = sha256('broken-op');
      seedAgent(db, agentHash, now);
      seedEndpoint(db, canonicalizeUrl(url), agentHash, now);

      const controller = new ProbeController(db, makeMockLnd(), bayesianDeps(db));
      const outcome = controller.ingestObservation(url, {
        url,
        target: 'L402',
        firstFetch: { status: 402, latencyMs: 10 },
        l402Challenge: { macaroonLen: 40, invoiceSats: 50, invoicePaymentHash: 'd'.repeat(64) },
        payment: { paymentHash: 'e'.repeat(64), preimage: 'f'.repeat(64), durationMs: 100 },
        secondFetch: { status: 500, latencyMs: 20, bodyBytes: 4, bodyHash: 'x'.repeat(64), bodyPreview: 'boom' },
        totalLatencyMs: 130,
        cost: { creditsDeducted: 5 },
      });

      expect(outcome.ingested).toBe(true);
      expect(outcome.success).toBe(false);

      const txRow = db.prepare(`SELECT status FROM transactions WHERE source = 'paid'`)
        .get() as { status: string };
      expect(txRow.status).toBe('failed');

      const repo = new EndpointStreamingPosteriorRepository(db);
      const dec = await repo.readDecayed(endpointHash(url), 'paid', now + 1);
      // Failure with weight 2.0 → β ≈ 3.5, α ≈ 1.5
      expect(dec.posteriorAlpha).toBeCloseTo(1.5, 1);
      expect(dec.posteriorBeta).toBeCloseTo(3.5, 1);
    });

    // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
    it.skip('is idempotent within the same 6h window bucket', async () => {
      const now = Math.floor(Date.now() / 1000);
      const url = 'https://idem.example/service';
      const agentHash = sha256('idem-op');
      seedAgent(db, agentHash, now);
      seedEndpoint(db, canonicalizeUrl(url), agentHash, now);

      const controller = new ProbeController(db, makeMockLnd(), bayesianDeps(db));
      const result: ProbeResult = {
        url,
        target: 'L402',
        firstFetch: { status: 402, latencyMs: 10 },
        l402Challenge: { macaroonLen: 40, invoiceSats: 50, invoicePaymentHash: 'd'.repeat(64) },
        payment: { paymentHash: 'e'.repeat(64), preimage: 'f'.repeat(64), durationMs: 100 },
        secondFetch: { status: 200, latencyMs: 20, bodyBytes: 11, bodyHash: 'x'.repeat(64), bodyPreview: 'ok' },
        totalLatencyMs: 130,
        cost: { creditsDeducted: 5 },
      };

      const first = controller.ingestObservation(url, result);
      const second = controller.ingestObservation(url, result);
      expect(first.ingested).toBe(true);
      expect(second.ingested).toBe(false);
      expect(second.reason).toBe('duplicate');

      const count = (db.prepare(`SELECT COUNT(*) as c FROM transactions WHERE source = 'paid'`)
        .get() as { c: number }).c;
      expect(count).toBe(1);
    });
  });

  describe('probe() handler — wires ingestion after a successful pipeline', async () => {
    // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
    it.skip('persists one tx (source=paid) after a full probe round-trip', async () => {
      const now = Math.floor(Date.now() / 1000);
      const url = 'https://full.example/svc';
      const agentHash = sha256('full-op');
      seedAgent(db, agentHash, now);
      seedEndpoint(db, canonicalizeUrl(url), agentHash, now);

      const preimage = crypto.randomBytes(32).toString('hex');
      seedPhase9Token(db, preimage, 100);

      const invoice = makeInvoice(10);
      const mac = Buffer.from('real-macaroon-bytes').toString('base64');
      const wwwAuth = `L402 macaroon="${mac}", invoice="${invoice}"`;
      const firstResp = {
        status: 402,
        headers: { get: (k: string) => (k.toLowerCase() === 'www-authenticate' ? wwwAuth : null) },
      };
      const secondResp = {
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => new TextEncoder().encode('paid ok').buffer,
      };
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(firstResp as unknown as Response)
        .mockResolvedValueOnce(secondResp as unknown as Response));

      const lnd = makeMockLnd({
        canPay: true,
        payResult: { paymentPreimage: 'c'.repeat(64), paymentHash: 'd'.repeat(64) },
      });
      const controller = new ProbeController(db, lnd, bayesianDeps(db));

      let captured: unknown;
      const req = { body: { url }, headers: { authorization: l402AuthHeader(preimage) } } as unknown as Parameters<typeof controller.probe>[0];
      const res = {
        status: () => res,
        json: (body: unknown) => { captured = body; },
      } as unknown as Parameters<typeof controller.probe>[1];
      const next = (() => { /* unused on success */ }) as Parameters<typeof controller.probe>[2];
      await controller.probe(req, res, next);

      expect(captured).toBeDefined();

      const txRow = db.prepare(`
        SELECT source, status, endpoint_hash, operator_id FROM transactions WHERE source = 'paid'
      `).get() as { source: string; status: string; endpoint_hash: string; operator_id: string } | undefined;
      expect(txRow).toBeDefined();
      expect(txRow!.source).toBe('paid');
      expect(txRow!.status).toBe('verified');
      expect(txRow!.operator_id).toBe(agentHash);

      const posterior = new EndpointStreamingPosteriorRepository(db).readDecayed(
        endpointHash(url), 'paid', now + 1,
      );
      expect(posterior.totalIngestions).toBe(1);
      expect(posterior.posteriorAlpha).toBeGreaterThan(posterior.posteriorBeta);
    });

    // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
    it.skip('does not persist a tx when the endpoint is unknown (no service_endpoints row)', async () => {
      const preimage = crypto.randomBytes(32).toString('hex');
      seedPhase9Token(db, preimage, 100);

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 200,
        headers: { get: () => null },
      } as unknown as Response));

      const lnd = makeMockLnd();
      const controller = new ProbeController(db, lnd, bayesianDeps(db));
      const req = { body: { url: 'https://never-heard-of.example/' }, headers: { authorization: l402AuthHeader(preimage) } } as unknown as Parameters<typeof controller.probe>[0];
      const res = {
        status: () => res,
        json: () => { /* ignore */ },
      } as unknown as Parameters<typeof controller.probe>[1];
      const next = (() => { /* ignore */ }) as Parameters<typeof controller.probe>[2];
      await controller.probe(req, res, next);

      const count = (db.prepare(`SELECT COUNT(*) as c FROM transactions`).get() as { c: number }).c;
      expect(count).toBe(0);
    });
  });

  describe('migration v40 — transactions.source accepts paid', () => {
    // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
    it.skip('accepts source=paid with the widened CHECK constraint', async () => {
      const now = Math.floor(Date.now() / 1000);
      const agentHash = sha256('mig-op');
      seedAgent(db, agentHash, now);

      const txId = sha256(`paid:test:${now}`);
      db.prepare(`
        INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol, endpoint_hash, operator_id, source, window_bucket)
        VALUES (?, ?, ?, 'micro', ?, ?, NULL, 'verified', 'l402', ?, ?, 'paid', ?)
      `).run(txId, agentHash, agentHash, now, sha256('ph'), sha256('eh'), agentHash, windowBucket(now));

      const row = db.prepare('SELECT source FROM transactions WHERE tx_id = ?')
        .get(txId) as { source: string };
      expect(row.source).toBe('paid');
    });

    // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
    it.skip('still rejects arbitrary source values', async () => {
      const now = Math.floor(Date.now() / 1000);
      const agentHash = sha256('mig-op-bad');
      seedAgent(db, agentHash, now);
      const txId = sha256(`bad:test:${now}`);
      expect(() => {
        db.prepare(`
          INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol, source)
          VALUES (?, ?, ?, 'micro', ?, ?, NULL, 'verified', 'l402', 'bogus')
        `).run(txId, agentHash, agentHash, now, sha256('ph'));
      }).toThrow(/CHECK constraint/);
    });
  });
});