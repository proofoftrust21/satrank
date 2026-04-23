// Tests middleware L402 natif — Phase 14D.3.0.
// Couvre les 3 branches (pas d'auth / deposit / macaroon) avec les 9 cas specifies :
//   1. no auth -> 402 + WWW-Authenticate (challenge)
//   2. deposit token -> next() passe-plat
//   3. macaroon valide + preimage valide + first-use settled -> next()
//   4. macaroon valide + token deja en DB -> next() sans LND
//   5. macaroon expired -> 401 EXPIRED
//   6. macaroon signature invalide -> 401 SIGNATURE_INVALID
//   7. preimage ne correspond pas au ph -> 401 PREIMAGE_MISMATCH
//   8. invoice pas encore settled -> 402 PAYMENT_PENDING
//   9. macaroon malformed (no dot) -> 401 MALFORMED

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { createL402Native } from '../middleware/l402Native';
import { encodeMacaroon, type MacaroonPayload } from '../utils/macaroonHmac';
import { LndInvoiceService } from '../services/lndInvoiceService';

const SECRET = Buffer.from('a'.repeat(64), 'hex');

type RowShape = { payment_hash: Buffer };

function makePool(options: { rows?: RowShape[] } = {}): Pool {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: options.rows ?? [], rowCount: options.rows?.length ?? 0 }),
  } as unknown as Pool;
  return pool;
}

function makeLndInvoice(options: {
  available?: boolean;
  addInvoice?: ReturnType<typeof vi.fn>;
  lookupInvoice?: ReturnType<typeof vi.fn>;
} = {}): LndInvoiceService {
  const svc = {
    isAvailable: vi.fn().mockReturnValue(options.available !== false),
    addInvoice: options.addInvoice ?? vi.fn().mockResolvedValue({
      r_hash: Buffer.alloc(32, 0xbb).toString('base64'),
      payment_request: 'lnbc1pnewinvoice',
    }),
    lookupInvoice: options.lookupInvoice ?? vi.fn().mockResolvedValue({
      settled: true,
      value: '1',
      memo: 'SatRank L402 /api/test',
    }),
  } as unknown as LndInvoiceService;
  return svc;
}

function buildApp(
  lndInvoice: LndInvoiceService,
  pool: Pool,
  overrides: Partial<Parameters<typeof createL402Native>[0]> = {},
) {
  const middleware = createL402Native({
    secret: SECRET,
    lndInvoice,
    pool,
    priceSats: 1,
    ttlSeconds: 60,
    expirySeconds: 600,
    ...overrides,
  });
  const app = express();
  app.use('/api/test', middleware, (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

function preimageForHash(hashHex: string): string {
  // Generate a deterministic preimage and its hash for tests where we
  // don't care about the actual invoice payment — we fix the preimage and
  // let the payload use SHA256(preimage) as ph.
  return hashHex;
}

describe('l402Native middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('no auth -> 402 challenge', () => {
    it('returns 402 with WWW-Authenticate + macaroon + invoice', async () => {
      const lnd = makeLndInvoice();
      const pool = makePool();
      const app = buildApp(lnd, pool);

      const res = await request(app).get('/api/test');
      expect(res.status).toBe(402);
      expect(res.body.error.code).toBe('PAYMENT_REQUIRED');
      expect(res.headers['www-authenticate']).toContain('L402 macaroon=');
      expect(res.headers['www-authenticate']).toContain('invoice="lnbc1pnewinvoice"');
      expect(res.body.data.priceSats).toBe(1);
      expect(res.body.data.paymentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(lnd.addInvoice).toHaveBeenCalledOnce();
      expect(lnd.addInvoice).toHaveBeenCalledWith(1, expect.stringContaining('SatRank L402'), 600);
    });

    it('returns 503 when LND invoice macaroon is unavailable', async () => {
      const lnd = makeLndInvoice({ available: false });
      const pool = makePool();
      const app = buildApp(lnd, pool);

      const res = await request(app).get('/api/test');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('uses pricingMap price when route pattern matches (router mount)', async () => {
      const addInvoice = vi.fn().mockResolvedValue({
        r_hash: Buffer.alloc(32, 0xbb).toString('base64'),
        payment_request: 'lnbc1pprobe5sat',
      });
      const lnd = makeLndInvoice({ addInvoice });
      const pool = makePool();
      const middleware = createL402Native({
        secret: SECRET,
        lndInvoice: lnd,
        pool,
        priceSats: 1,
        ttlSeconds: 60,
        expirySeconds: 600,
        pricingMap: { '/probe': 5, '/agent/:hash': 1 },
      });
      // Router mounted under /api reproduces the production wiring: inside
      // the router, req.route.path = '/probe' (pattern without /api prefix).
      const router = express.Router();
      router.post('/probe', middleware, (_req, res) => res.status(200).json({ ok: true }));
      const app = express();
      app.use('/api', router);

      const res = await request(app).post('/api/probe');
      expect(res.status).toBe(402);
      expect(res.body.data.priceSats).toBe(5);
      expect(addInvoice).toHaveBeenCalledWith(5, expect.any(String), 600);
    });

    it('falls back to default priceSats when pricingMap has no match', async () => {
      const addInvoice = vi.fn().mockResolvedValue({
        r_hash: Buffer.alloc(32, 0xbb).toString('base64'),
        payment_request: 'lnbc1pfallback',
      });
      const lnd = makeLndInvoice({ addInvoice });
      const pool = makePool();
      const middleware = createL402Native({
        secret: SECRET,
        lndInvoice: lnd,
        pool,
        priceSats: 3,
        ttlSeconds: 60,
        expirySeconds: 600,
        pricingMap: { '/probe': 5 },
      });
      const router = express.Router();
      router.get('/other', middleware, (_req, res) => res.status(200).json({ ok: true }));
      const app = express();
      app.use('/api', router);

      const res = await request(app).get('/api/other');
      expect(res.status).toBe(402);
      expect(res.body.data.priceSats).toBe(3);
      expect(addInvoice).toHaveBeenCalledWith(3, expect.any(String), 600);
    });
  });

  describe('deposit token -> passthrough', () => {
    it('calls next() without touching LND or DB', async () => {
      const lnd = makeLndInvoice();
      const pool = makePool();
      const app = buildApp(lnd, pool);

      const res = await request(app)
        .get('/api/test')
        .set('Authorization', 'L402 deposit:' + 'a'.repeat(64));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(lnd.addInvoice).not.toHaveBeenCalled();
      expect(lnd.lookupInvoice).not.toHaveBeenCalled();
    });
  });

  describe('macaroon + preimage -> verify path', () => {
    function makeValidMacaroonToken(overrides: Partial<MacaroonPayload> = {}): {
      macaroon: string;
      preimage: string;
      paymentHash: string;
    } {
      const preimage = 'c'.repeat(64);
      const paymentHash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
      const payload: MacaroonPayload = {
        v: 1,
        ph: paymentHash,
        ca: Math.floor(Date.now() / 1000),
        ps: 1,
        rt: '/api/test',
        tt: 60,
        ...overrides,
      };
      const macaroon = encodeMacaroon(payload, SECRET);
      return { macaroon, preimage, paymentHash };
    }

    it('first-use: accepts after LND lookupInvoice confirms settled', async () => {
      const lnd = makeLndInvoice();
      const pool = makePool(); // no existing row -> first use
      const app = buildApp(lnd, pool);
      const { macaroon, preimage } = makeValidMacaroonToken();

      const res = await request(app)
        .get('/api/test')
        .set('Authorization', `L402 ${macaroon}:${preimage}`);

      expect(res.status).toBe(200);
      expect(lnd.lookupInvoice).toHaveBeenCalledOnce();
      expect(pool.query).toHaveBeenCalled();
    });

    it('cached path: skips LND lookup when token already in DB', async () => {
      const { macaroon, preimage, paymentHash } = makeValidMacaroonToken();
      const lnd = makeLndInvoice();
      const pool = makePool({ rows: [{ payment_hash: Buffer.from(paymentHash, 'hex') }] });
      const app = buildApp(lnd, pool);

      const res = await request(app)
        .get('/api/test')
        .set('Authorization', `L402 ${macaroon}:${preimage}`);

      expect(res.status).toBe(200);
      expect(lnd.lookupInvoice).not.toHaveBeenCalled();
    });

    it('rejects expired macaroon with 401 EXPIRED', async () => {
      const oldCa = Math.floor(Date.now() / 1000) - 10_000;
      const { macaroon, preimage } = makeValidMacaroonToken({ ca: oldCa, tt: 60 });
      const lnd = makeLndInvoice();
      const pool = makePool();
      const app = buildApp(lnd, pool);

      const res = await request(app)
        .get('/api/test')
        .set('Authorization', `L402 ${macaroon}:${preimage}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('EXPIRED');
      expect(lnd.lookupInvoice).not.toHaveBeenCalled();
    });

    it('rejects macaroon signed with wrong secret (SIGNATURE_INVALID)', async () => {
      const preimage = 'c'.repeat(64);
      const paymentHash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
      const payload: MacaroonPayload = {
        v: 1,
        ph: paymentHash,
        ca: Math.floor(Date.now() / 1000),
        ps: 1,
        rt: '/api/test',
        tt: 60,
      };
      const forged = encodeMacaroon(payload, Buffer.from('b'.repeat(64), 'hex'));
      const lnd = makeLndInvoice();
      const pool = makePool();
      const app = buildApp(lnd, pool);

      const res = await request(app)
        .get('/api/test')
        .set('Authorization', `L402 ${forged}:${preimage}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('SIGNATURE_INVALID');
    });

    it('rejects when preimage does not match payload.ph (PREIMAGE_MISMATCH)', async () => {
      const { macaroon } = makeValidMacaroonToken();
      const wrongPreimage = 'd'.repeat(64);
      const lnd = makeLndInvoice();
      const pool = makePool();
      const app = buildApp(lnd, pool);

      const res = await request(app)
        .get('/api/test')
        .set('Authorization', `L402 ${macaroon}:${wrongPreimage}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('PREIMAGE_MISMATCH');
    });

    it('rejects with 402 PAYMENT_PENDING when LND reports invoice unsettled', async () => {
      const { macaroon, preimage } = makeValidMacaroonToken();
      const lnd = makeLndInvoice({
        lookupInvoice: vi.fn().mockResolvedValue({ settled: false, value: '1', memo: '' }),
      });
      const pool = makePool();
      const app = buildApp(lnd, pool);

      const res = await request(app)
        .get('/api/test')
        .set('Authorization', `L402 ${macaroon}:${preimage}`);

      expect(res.status).toBe(402);
      expect(res.body.error.code).toBe('PAYMENT_PENDING');
    });

    it('rejects malformed Authorization header (no preimage) with 401 INVALID_AUTH', async () => {
      const { macaroon } = makeValidMacaroonToken();
      const lnd = makeLndInvoice();
      const pool = makePool();
      const app = buildApp(lnd, pool);

      const res = await request(app)
        .get('/api/test')
        .set('Authorization', `L402 ${macaroon}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_AUTH');
    });

    it('rejects macaroon with no dot separator (MALFORMED)', async () => {
      const preimage = 'c'.repeat(64);
      const lnd = makeLndInvoice();
      const pool = makePool();
      const app = buildApp(lnd, pool);

      const res = await request(app)
        .get('/api/test')
        .set('Authorization', `L402 nodotsinthistokenatall:${preimage}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('MALFORMED');
    });

    it('rejects macaroon with unsupported version (VERSION_UNSUPPORTED)', async () => {
      const preimage = 'c'.repeat(64);
      const paymentHash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
      const payload = {
        v: 2,
        ph: paymentHash,
        ca: Math.floor(Date.now() / 1000),
        ps: 1,
        rt: '/api/test',
        tt: 60,
      } as unknown as MacaroonPayload;
      const token = encodeMacaroon(payload, SECRET);
      const lnd = makeLndInvoice();
      const pool = makePool();
      const app = buildApp(lnd, pool);

      const res = await request(app)
        .get('/api/test')
        .set('Authorization', `L402 ${token}:${preimage}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('VERSION_UNSUPPORTED');
    });
  });

  describe('operator bypass (X-Operator-Token)', () => {
    const OPERATOR_SECRET = 'ops-' + 'f'.repeat(60);

    it('bypasses gate when X-Operator-Token matches operatorSecret', async () => {
      const lnd = makeLndInvoice();
      const pool = makePool();
      const app = buildApp(lnd, pool, { operatorSecret: OPERATOR_SECRET });

      const res = await request(app).get('/api/test').set('X-Operator-Token', OPERATOR_SECRET);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(lnd.addInvoice).not.toHaveBeenCalled();
      expect(lnd.lookupInvoice).not.toHaveBeenCalled();
    });

    it('falls through to 402 challenge when X-Operator-Token does not match', async () => {
      const lnd = makeLndInvoice();
      const pool = makePool();
      const app = buildApp(lnd, pool, { operatorSecret: OPERATOR_SECRET });

      const res = await request(app).get('/api/test').set('X-Operator-Token', 'wrong-secret');
      expect(res.status).toBe(402);
      expect(res.body.error.code).toBe('PAYMENT_REQUIRED');
      expect(lnd.addInvoice).toHaveBeenCalledOnce();
    });

    it('falls through to 402 challenge when X-Operator-Token is empty', async () => {
      const lnd = makeLndInvoice();
      const pool = makePool();
      const app = buildApp(lnd, pool, { operatorSecret: OPERATOR_SECRET });

      const res = await request(app).get('/api/test').set('X-Operator-Token', '');
      expect(res.status).toBe(402);
      expect(res.body.error.code).toBe('PAYMENT_REQUIRED');
      expect(lnd.addInvoice).toHaveBeenCalledOnce();
    });

    it('ignores X-Operator-Token when operatorSecret is not configured', async () => {
      const lnd = makeLndInvoice();
      const pool = makePool();
      const app = buildApp(lnd, pool);

      const res = await request(app).get('/api/test').set('X-Operator-Token', OPERATOR_SECRET);
      expect(res.status).toBe(402);
      expect(res.body.error.code).toBe('PAYMENT_REQUIRED');
    });
  });
});

// Silence unused helper warning in case the test is refactored later.
void preimageForHash;
