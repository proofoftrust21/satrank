// Phase 14D.3.0 etape 3 — tests integration du wiring l402Native sur les 7
// routes paid (6 originales + /api/probe). Valide :
//   - feature flag OFF : paidGate = apertureGateAuth (status quo)
//   - feature flag ON  : chaque route emet un 402 + challenge au premier hit
//   - pricingMap : /probe = 5 sats, les 6 autres = 1 sat
//   - deposit token : bypass macaroon (passe-plat)
//   - paiement settled : 200 end-to-end
//   - LND fails : 503 gracieux
//
// Mock : LndInvoiceService stubbed + pool mocke (pas de Postgres, pas de LND).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { createL402Native } from '../middleware/l402Native';
import { encodeMacaroon, type MacaroonPayload } from '../utils/macaroonHmac';
import { LndInvoiceService } from '../services/lndInvoiceService';
import { createAgentRoutes } from '../routes/agent';
import { createAttestationRoutes } from '../routes/attestation';
import { createV2Routes } from '../routes/v2';
import type { AgentController } from '../controllers/agentController';
import type { AttestationController } from '../controllers/attestationController';
import type { V2Controller } from '../controllers/v2Controller';

const SECRET = Buffer.from('a'.repeat(64), 'hex');

const PRICING_MAP = {
  '/probe': 5,
  '/verdicts': 1,
  '/agent/:publicKeyHash': 1,
  '/agent/:publicKeyHash/verdict': 1,
  '/agent/:publicKeyHash/history': 1,
  '/agent/:publicKeyHash/attestations': 1,
  '/profile/:id': 1,
};

function makeLnd(options: {
  available?: boolean;
  addInvoice?: ReturnType<typeof vi.fn>;
  lookupInvoice?: ReturnType<typeof vi.fn>;
} = {}): LndInvoiceService {
  return {
    isAvailable: vi.fn().mockReturnValue(options.available !== false),
    addInvoice: options.addInvoice ?? vi.fn().mockResolvedValue({
      r_hash: Buffer.alloc(32, 0xbb).toString('base64'),
      payment_request: 'lnbc1pmockinvoice',
    }),
    lookupInvoice: options.lookupInvoice ?? vi.fn().mockResolvedValue({
      settled: true,
      value: '1',
      memo: '',
    }),
  } as unknown as LndInvoiceService;
}

function makePool(rows: { payment_hash: Buffer }[] = []): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  } as unknown as Pool;
}

function stubHandler(): RequestHandler {
  return (_req, res) => res.status(200).json({ ok: true });
}

function stubController<T extends object>(handlers: Record<string, RequestHandler>): T {
  return handlers as unknown as T;
}

function buildApp(paidGate: RequestHandler, balanceAuth: RequestHandler = (_r, _s, n) => n()): express.Express {
  const agentController = stubController<AgentController>({
    getTop: stubHandler(),
    getMovers: stubHandler(),
    search: stubHandler(),
    batchVerdicts: stubHandler(),
    getVerdict: stubHandler(),
    getAgent: stubHandler(),
    getHistory: stubHandler(),
  });
  const attestationController = stubController<AttestationController>({
    getBySubject: stubHandler(),
    create: stubHandler(),
  });
  const v2Controller = stubController<V2Controller>({
    report: stubHandler(),
    profile: stubHandler(),
  });

  const app = express();
  app.use(express.json());
  const api = express.Router();
  api.use(createV2Routes(v2Controller, balanceAuth, (_r, _s, n) => n(), undefined, paidGate));
  api.post('/probe', paidGate, balanceAuth, stubHandler());
  api.use(createAgentRoutes(agentController, balanceAuth, paidGate));
  api.use(createAttestationRoutes(attestationController, balanceAuth, paidGate));
  app.use('/api', api);
  return app;
}

interface RouteDescriptor {
  method: 'get' | 'post';
  path: string;
  expectedPriceSats: number;
  label: string;
}

const SEVEN_PAID_ROUTES: RouteDescriptor[] = [
  { method: 'post', path: '/api/verdicts', expectedPriceSats: 1, label: 'POST /api/verdicts' },
  { method: 'get', path: '/api/agent/' + 'a'.repeat(64) + '/verdict', expectedPriceSats: 1, label: 'GET /api/agent/:hash/verdict' },
  { method: 'get', path: '/api/agent/' + 'a'.repeat(64), expectedPriceSats: 1, label: 'GET /api/agent/:hash' },
  { method: 'get', path: '/api/agent/' + 'a'.repeat(64) + '/history', expectedPriceSats: 1, label: 'GET /api/agent/:hash/history' },
  { method: 'get', path: '/api/agent/' + 'a'.repeat(64) + '/attestations', expectedPriceSats: 1, label: 'GET /api/agent/:hash/attestations' },
  { method: 'get', path: '/api/profile/abc123', expectedPriceSats: 1, label: 'GET /api/profile/:id' },
  { method: 'post', path: '/api/probe', expectedPriceSats: 5, label: 'POST /api/probe' },
];

describe('l402Native wiring — 7 paid routes integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('feature flag OFF — paidGate is a pass-through (smoke)', () => {
    // When featureFlags.l402Native === false, production wires
    // paidGate = apertureGateAuth (real auth stack). For this smoke test we
    // pass a permissive no-op to prove the route factories accept the gate
    // injection without affecting the handler path — the actual
    // apertureGateAuth behavior is covered elsewhere.
    const noopGate: RequestHandler = (_req, _res, next) => next();

    for (const route of SEVEN_PAID_ROUTES) {
      it(`${route.label} -> 200 when gate is permissive`, async () => {
        const app = buildApp(noopGate);
        const res = await request(app)[route.method](route.path);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
      });
    }
  });

  describe('feature flag ON — l402Native emits 402 challenge per route', () => {
    for (const route of SEVEN_PAID_ROUTES) {
      it(`${route.label} -> 402 with priceSats=${route.expectedPriceSats}`, async () => {
        const addInvoice = vi.fn().mockResolvedValue({
          r_hash: Buffer.alloc(32, 0xbb).toString('base64'),
          payment_request: 'lnbc1pmock',
        });
        const lnd = makeLnd({ addInvoice });
        const pool = makePool();
        const paidGate = createL402Native({
          secret: SECRET,
          lndInvoice: lnd,
          pool,
          priceSats: 1,
          ttlSeconds: 60,
          expirySeconds: 600,
          pricingMap: PRICING_MAP,
        });
        const app = buildApp(paidGate);

        const res = await request(app)[route.method](route.path);
        expect(res.status).toBe(402);
        expect(res.body.error.code).toBe('PAYMENT_REQUIRED');
        expect(res.body.data.priceSats).toBe(route.expectedPriceSats);
        expect(addInvoice).toHaveBeenCalledWith(route.expectedPriceSats, expect.any(String), 600);
      });
    }
  });

  describe('feature flag ON — settled macaroon path', () => {
    it('GET /api/agent/:hash with valid L402 Authorization + settled invoice -> 200', async () => {
      const preimage = 'c'.repeat(64);
      const paymentHash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
      const payload: MacaroonPayload = {
        v: 1,
        ph: paymentHash,
        ca: Math.floor(Date.now() / 1000),
        ps: 1,
        rt: '/api/agent/:hash',
        tt: 60,
      };
      const macaroon = encodeMacaroon(payload, SECRET);
      const lnd = makeLnd();
      const pool = makePool();
      const paidGate = createL402Native({
        secret: SECRET,
        lndInvoice: lnd,
        pool,
        priceSats: 1,
        ttlSeconds: 60,
        expirySeconds: 600,
        pricingMap: PRICING_MAP,
      });
      const app = buildApp(paidGate);

      const res = await request(app)
        .get('/api/agent/' + 'a'.repeat(64))
        .set('Authorization', `L402 ${macaroon}:${preimage}`);

      expect(res.status).toBe(200);
      expect(lnd.lookupInvoice).toHaveBeenCalledOnce();
    });
  });

  describe('feature flag ON — deposit token bypass', () => {
    it('GET /api/profile/:id with L402 deposit:<preimage> -> 200 without LND call', async () => {
      const preimage = 'd'.repeat(64);
      const lnd = makeLnd();
      const pool = makePool();
      const paidGate = createL402Native({
        secret: SECRET,
        lndInvoice: lnd,
        pool,
        priceSats: 1,
        ttlSeconds: 60,
        expirySeconds: 600,
        pricingMap: PRICING_MAP,
      });
      const app = buildApp(paidGate);

      const res = await request(app)
        .get('/api/profile/abc123')
        .set('Authorization', `L402 deposit:${preimage}`);

      expect(res.status).toBe(200);
      expect(lnd.addInvoice).not.toHaveBeenCalled();
      expect(lnd.lookupInvoice).not.toHaveBeenCalled();
    });
  });

  describe('feature flag ON — LND unavailable', () => {
    it('returns 503 when LND invoice macaroon not loaded', async () => {
      const lnd = makeLnd({ available: false });
      const pool = makePool();
      const paidGate = createL402Native({
        secret: SECRET,
        lndInvoice: lnd,
        pool,
        priceSats: 1,
        ttlSeconds: 60,
        expirySeconds: 600,
        pricingMap: PRICING_MAP,
      });
      const app = buildApp(paidGate);

      const res = await request(app).post('/api/probe');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('returns 500 when LND addInvoice throws', async () => {
      const addInvoice = vi.fn().mockRejectedValue(new Error('LND addInvoice failed: 500 internal'));
      const lnd = makeLnd({ addInvoice });
      const pool = makePool();
      const paidGate = createL402Native({
        secret: SECRET,
        lndInvoice: lnd,
        pool,
        priceSats: 1,
        ttlSeconds: 60,
        expirySeconds: 600,
        pricingMap: PRICING_MAP,
      });
      const app = buildApp(paidGate);
      app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
      });

      const res = await request(app).get('/api/profile/abc123');
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL');
    });
  });
});
