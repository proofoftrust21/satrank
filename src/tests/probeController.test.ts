// Tests for ProbeController — unit-level, mocking fetch + LND client.
// Covers the full probe pipeline (fetch → 402 detect → L402 parse → BOLT11
// parse → pay → retry) plus the accounting guards (5 credits, admin macaroon,
// PROBE_MAX_INVOICE_SATS cap).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import crypto from 'crypto';
import * as bolt11 from 'bolt11';
import { ProbeController } from '../controllers/probeController';
import type { LndGraphClient } from '../crawler/lndGraphClient';
let testDb: TestDb;

// --- Fixtures ---
/** Private key used only to sign the fake BOLT11 invoices this test builds.
 *  Generated once per test process — never used outside vitest, no real sats
 *  ever touch it. Avoids committing a literal 32-byte hex that secret scanners
 *  flag as a leaked key. */
const TEST_PRIVKEY = crypto.randomBytes(32).toString('hex');

/** Build a BOLT11 invoice that bolt11Parser will accept (encode → sign). */
function makeInvoice(amountSats: number, paymentHashHex?: string): string {
  const paymentHash = paymentHashHex ?? crypto.randomBytes(32).toString('hex');
  const encoded = bolt11.encode({
    satoshis: amountSats,
    timestamp: Math.floor(Date.now() / 1000),
    tags: [
      { tagName: 'payment_hash', data: paymentHash },
      { tagName: 'description', data: 'probe test invoice' },
      { tagName: 'expire_time', data: 3600 },
      { tagName: 'payment_secret', data: crypto.randomBytes(32).toString('hex') },
    ],
    network: {
      bech32: 'bc',
      pubKeyHash: 0x00,
      scriptHash: 0x05,
      validWitnessVersions: [0, 1],
    },
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

/** Minimal mock LND client — only the two methods ProbeController uses. */
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

describe('ProbeController', async () => {
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

  describe('probe() handler (controller-level)', async () => {
    function callProbe(
      controller: ProbeController,
      body: unknown,
      authHeader?: string,
    ): Promise<{ status: number; body: unknown; errorCode?: string }> {
      return new Promise((resolve) => {
        const req = { body, headers: { authorization: authHeader } } as unknown as Parameters<typeof controller.probe>[0];
        let statusCode = 200;
        const res = {
          status: (code: number) => {
            statusCode = code;
            return res;
          },
          json: (body: unknown) => {
            resolve({ status: statusCode, body });
          },
        } as unknown as Parameters<typeof controller.probe>[1];
        const next = ((err?: unknown) => {
          if (err && typeof err === 'object' && 'statusCode' in err) {
            const appErr = err as { statusCode: number; code: string; message: string };
            resolve({ status: appErr.statusCode, body: { error: { code: appErr.code, message: appErr.message } }, errorCode: appErr.code });
          } else {
            resolve({ status: statusCode, body: null });
          }
        }) as Parameters<typeof controller.probe>[2];
        void controller.probe(req, res, next);
      });
    }

    it('rejects missing url in body (VALIDATION_ERROR)', async () => {
      const lnd = makeMockLnd();
      const controller = new ProbeController(db, lnd);
      const r = await callProbe(controller, {});
      expect(r.status).toBe(400);
      expect(r.errorCode).toBe('VALIDATION_ERROR');
    });

    it('rejects non-URL input (VALIDATION_ERROR)', async () => {
      const lnd = makeMockLnd();
      const controller = new ProbeController(db, lnd);
      const r = await callProbe(controller, { url: 'not-a-url' });
      expect(r.status).toBe(400);
      expect(r.errorCode).toBe('VALIDATION_ERROR');
    });

    it('returns PROBE_UNAVAILABLE when admin macaroon is not loaded', async () => {
      const lnd = makeMockLnd({ canPay: false });
      const controller = new ProbeController(db, lnd);
      const r = await callProbe(controller, { url: 'https://example.com' });
      expect(r.status).toBe(503);
      expect(r.errorCode).toBe('PROBE_UNAVAILABLE');
    });

    it('rejects missing Authorization header (VALIDATION_ERROR)', async () => {
      const lnd = makeMockLnd();
      const controller = new ProbeController(db, lnd);
      const r = await callProbe(controller, { url: 'https://example.com' }, undefined);
      expect(r.status).toBe(400);
      expect(r.errorCode).toBe('VALIDATION_ERROR');
    });

    it('rejects non-L402 Authorization header (VALIDATION_ERROR)', async () => {
      const lnd = makeMockLnd();
      const controller = new ProbeController(db, lnd);
      const r = await callProbe(controller, { url: 'https://example.com' }, 'Bearer foo');
      expect(r.status).toBe(400);
      expect(r.errorCode).toBe('VALIDATION_ERROR');
    });

    it('returns INSUFFICIENT_CREDITS when token has < 4 credits', async () => {
      const preimage = crypto.randomBytes(32).toString('hex');
      await seedPhase9Token(db, preimage, 3); // < 4 needed
      const lnd = makeMockLnd();
      const controller = new ProbeController(db, lnd);
      const r = await callProbe(controller, { url: 'https://example.com' }, l402AuthHeader(preimage));
      expect(r.status).toBe(402);
      expect(r.errorCode).toBe('INSUFFICIENT_CREDITS');
    });

    it('returns INSUFFICIENT_CREDITS for a legacy token (rate IS NULL)', async () => {
      // Legacy auto-created token — should not be accepted on the paid probe endpoint.
      const preimage = crypto.randomBytes(32).toString('hex');
      const ph = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest();
      // Seed a legacy row (rate NULL) with plenty of remaining sats.
      await db.query(
        'INSERT INTO token_balance (payment_hash, remaining, created_at, max_quota) VALUES ($1, $2, $3, $4)',
        [ph, 20, Math.floor(Date.now() / 1000), 21],
      );
      const lnd = makeMockLnd();
      const controller = new ProbeController(db, lnd);
      const r = await callProbe(controller, { url: 'https://example.com/' }, l402AuthHeader(preimage));
      expect(r.status).toBe(402);
      expect(r.errorCode).toBe('INSUFFICIENT_CREDITS');
    });

    it('debits exactly 4 credits when the probe proceeds', async () => {
      const preimage = crypto.randomBytes(32).toString('hex');
      const ph = await seedPhase9Token(db, preimage, 100);
      // Mock fetch so performProbe returns early with a NOT_L402 target.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 200,
        headers: { get: () => null },
      } as unknown as Response));
      const lnd = makeMockLnd();
      const controller = new ProbeController(db, lnd);
      const r = await callProbe(controller, { url: 'https://example.com/' }, l402AuthHeader(preimage));
      expect(r.status).toBe(200);
      const { rows } = await db.query<{ balance_credits: number }>(
        'SELECT balance_credits FROM token_balance WHERE payment_hash = $1',
        [ph],
      );
      expect(Number(rows[0].balance_credits)).toBe(96); // 100 - 4
    });
  });

  describe('performProbe() pipeline', async () => {
    it('returns UNREACHABLE when the first fetch throws', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENOTFOUND')));
      const lnd = makeMockLnd();
      const controller = new ProbeController(db, lnd);
      const result = await controller.performProbe('https://offline.example/');
      expect(result.target).toBe('UNREACHABLE');
      expect(result.firstFetch.status).toBeNull();
      expect(result.firstFetch.httpError).toContain('ENOTFOUND');
      expect(result.totalLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('returns NOT_L402 for a 200 OK endpoint', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 200,
        headers: { get: () => null },
      } as unknown as Response));
      const lnd = makeMockLnd();
      const controller = new ProbeController(db, lnd);
      const result = await controller.performProbe('https://nope.example/');
      expect(result.target).toBe('NOT_L402');
      expect(result.firstFetch.status).toBe(200);
    });

    it('returns NOT_L402 for a 402 with a non-L402 WWW-Authenticate header', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 402,
        headers: { get: (k: string) => (k.toLowerCase() === 'www-authenticate' ? 'Bearer realm="x"' : null) },
      } as unknown as Response));
      const lnd = makeMockLnd();
      const controller = new ProbeController(db, lnd);
      const result = await controller.performProbe('https://bearer.example/');
      expect(result.target).toBe('NOT_L402');
    });

    it('caps invoice at PROBE_MAX_INVOICE_SATS and does not call payInvoice', async () => {
      const hugeInvoice = makeInvoice(10_000_000); // way over the 1000 sat cap
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 402,
        headers: {
          get: (k: string) => (k.toLowerCase() === 'www-authenticate'
            ? `L402 macaroon="${Buffer.from('mac').toString('base64')}", invoice="${hugeInvoice}"`
            : null),
        },
      } as unknown as Response));
      const lnd = makeMockLnd();
      const controller = new ProbeController(db, lnd);
      const result = await controller.performProbe('https://big.example/');
      expect(result.target).toBe('L402');
      expect(result.payment?.paymentError).toContain('exceeds PROBE_MAX_INVOICE_SATS');
      expect(lnd.payInvoice).not.toHaveBeenCalled();
    });

    it('completes the full pipeline and returns a secondFetch on success', async () => {
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
        arrayBuffer: async () => new TextEncoder().encode('hello probe').buffer,
      };
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(firstResp as unknown as Response)
        .mockResolvedValueOnce(secondResp as unknown as Response);
      vi.stubGlobal('fetch', fetchMock);

      const lnd = makeMockLnd({
        canPay: true,
        payResult: { paymentPreimage: 'c'.repeat(64), paymentHash: 'd'.repeat(64) },
      });
      const controller = new ProbeController(db, lnd);
      const result = await controller.performProbe('https://ok.example/');

      expect(result.target).toBe('L402');
      expect(result.l402Challenge?.invoiceSats).toBe(10);
      expect(result.payment?.preimage).toBe('c'.repeat(64));
      expect(result.payment?.paymentError).toBeUndefined();
      expect(result.secondFetch?.status).toBe(200);
      expect(result.secondFetch?.bodyBytes).toBe('hello probe'.length);
      expect(result.secondFetch?.bodyPreview).toBe('hello probe');
      expect(result.secondFetch?.bodyHash).toMatch(/^[a-f0-9]{64}$/);
      // Second fetch was called with the L402 Authorization header.
      const secondCall = fetchMock.mock.calls[1];
      const init = secondCall[1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe(`L402 ${mac}:${'c'.repeat(64)}`);
    });

    it('surfaces payment_error from LND without attempting retry', async () => {
      const invoice = makeInvoice(50);
      const mac = Buffer.from('mac-bytes').toString('base64');
      const wwwAuth = `L402 macaroon="${mac}", invoice="${invoice}"`;
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
        status: 402,
        headers: { get: (k: string) => (k.toLowerCase() === 'www-authenticate' ? wwwAuth : null) },
      } as unknown as Response));

      const lnd = makeMockLnd({
        payResult: { paymentPreimage: '', paymentHash: '', paymentError: 'no route to destination' },
      });
      const controller = new ProbeController(db, lnd);
      const result = await controller.performProbe('https://fail.example/');

      expect(result.target).toBe('L402');
      expect(result.payment?.paymentError).toBe('no route to destination');
      expect(result.secondFetch).toBeUndefined();
    });

    it('handles a BOLT11 that fails to decode cleanly', async () => {
      const mac = Buffer.from('mac-bytes').toString('base64');
      const wwwAuth = `L402 macaroon="${mac}", invoice="lnbc-not-a-real-invoice"`;
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 402,
        headers: { get: (k: string) => (k.toLowerCase() === 'www-authenticate' ? wwwAuth : null) },
      } as unknown as Response));
      const lnd = makeMockLnd();
      const controller = new ProbeController(db, lnd);
      const result = await controller.performProbe('https://broken.example/');
      expect(result.target).toBe('L402');
      expect(result.firstFetch.httpError).toContain('invalid BOLT11');
      expect(lnd.payInvoice).not.toHaveBeenCalled();
    });
  });
});
