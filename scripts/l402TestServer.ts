/**
 * L402 native test server — dev/local only.
 *
 * Spawns a minimal Express instance with stubbed LND for manual end-to-end
 * testing of the L402 native middleware without touching prod LND.
 *
 * Usage: npx tsx scripts/l402TestServer.ts
 * See Phase 14D.3.0 etape 4 rapport for test scenarios.
 *
 * NOT invoked by prod. NOT imported by src/app.ts.
 */
// Phase 14D.3.0 etape 4 — test server E2E manuel pour l402Native.
//
// Boot un serveur Express minimal sur :3001 avec :
//   - createL402Native (production) cablant les 7 routes paid
//   - Stub LndInvoiceService (aucun appel LND reel)
//   - Stub Pool (rows=[] pour forcer first-use lookup)
//   - Handlers stubs renvoyant { ok: true, route }
//   - Side-channel POST /_test/settle/:rHashHex pour simuler le paiement
//
// Variables d'env supportees (toutes optionnelles) :
//   PORT (default 3001)
//   L402_MACAROON_SECRET (default = 32 octets aleatoires par boot)
//   L402_NATIVE_ENABLED=false pour desactiver le middleware (fallback noop)

import crypto from 'crypto';
import express, { type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { createL402Native } from '../src/middleware/l402Native';
import {
  LndInvoiceService,
  type LndAddInvoiceResponse,
  type LndLookupInvoiceResponse,
} from '../src/services/lndInvoiceService';

const PORT = Number(process.env.PORT ?? 3001);
const SECRET_HEX = process.env.L402_MACAROON_SECRET ?? crypto.randomBytes(32).toString('hex');
const SECRET = Buffer.from(SECRET_HEX, 'hex');
const L402_ENABLED = process.env.L402_NATIVE_ENABLED !== 'false';

// --- Stub LND service -----------------------------------------------------
interface StubInvoice {
  rHashHex: string;
  valueSat: number;
  memo: string;
  createdAt: number;
  settled: boolean;
  preimageHex: string;
}

class StubLndInvoiceService extends LndInvoiceService {
  public invoices = new Map<string, StubInvoice>();
  public lastInvoice: StubInvoice | null = null;

  constructor() {
    super({ restUrl: 'http://stub-lnd', macaroonPath: undefined });
  }

  override isAvailable(): boolean {
    return true;
  }

  override async addInvoice(valueSat: number, memo: string, _expirySec: number): Promise<LndAddInvoiceResponse> {
    // r_hash deterministe bien forme (32 bytes), preimage derive pour settle simulee
    const preimage = crypto.randomBytes(32);
    const rHashBuf = crypto.createHash('sha256').update(preimage).digest();
    const rHashHex = rHashBuf.toString('hex');
    const inv: StubInvoice = {
      rHashHex,
      valueSat,
      memo,
      createdAt: Date.now(),
      settled: false,
      preimageHex: preimage.toString('hex'),
    };
    this.invoices.set(rHashHex, inv);
    this.lastInvoice = inv;
    // BOLT11 fabrique : prefixe valide (lnbc{valueSat*10}n1p) pour la lecture
    // visuelle du curl ; jamais parse par le middleware.
    const stubBolt11 = `lnbc${valueSat * 10}n1pstub${rHashHex.slice(0, 16)}`;
    return {
      r_hash: rHashBuf.toString('base64'),
      payment_request: stubBolt11,
    };
  }

  override async lookupInvoice(rHashHex: string): Promise<LndLookupInvoiceResponse> {
    const inv = this.invoices.get(rHashHex);
    if (!inv) {
      return { settled: false, value: '0', memo: '' };
    }
    return { settled: inv.settled, value: String(inv.valueSat), memo: inv.memo };
  }
}

// --- Stub Pool -----------------------------------------------------------
function makeStubPool(): Pool {
  return {
    query: async () => ({ rows: [], rowCount: 0, fields: [], command: '', oid: 0 }),
  } as unknown as Pool;
}

// --- Stub handlers -------------------------------------------------------
function stubHandler(label: string): RequestHandler {
  return (req, res) => {
    res.status(200).json({ ok: true, route: req.route?.path, label, method: req.method });
  };
}

const noopBalance: RequestHandler = (_req, _res, next) => next();
const noopGate: RequestHandler = (_req, _res, next) => next();

// --- App bootstrap -------------------------------------------------------
const app = express();
app.use(express.json());

const lnd = new StubLndInvoiceService();
const pool = makeStubPool();

const l402Native = createL402Native({
  secret: SECRET,
  lndInvoice: lnd,
  pool,
  priceSats: 1,
  ttlSeconds: 30 * 24 * 60 * 60,
  expirySeconds: 600,
  pricingMap: {
    '/probe': 5,
    '/verdicts': 1,
    '/agent/:publicKeyHash': 1,
    '/agent/:publicKeyHash/verdict': 1,
    '/agent/:publicKeyHash/history': 1,
    '/agent/:publicKeyHash/attestations': 1,
    '/profile/:id': 1,
  },
});

const paidGate: RequestHandler = L402_ENABLED ? l402Native : noopGate;

// Router /api (mime la production : createAgentRoutes/Attestation/V2 sont
// montes sous /api donc req.route.path = pattern relatif au router)
const api = express.Router();
api.post('/verdicts', paidGate, noopBalance, stubHandler('verdicts'));
api.get('/agent/:publicKeyHash/verdict', paidGate, noopBalance, stubHandler('agent.verdict'));
api.get('/agent/:publicKeyHash', paidGate, noopBalance, stubHandler('agent.get'));
api.get('/agent/:publicKeyHash/history', paidGate, noopBalance, stubHandler('agent.history'));
api.get('/agent/:publicKeyHash/attestations', paidGate, noopBalance, stubHandler('agent.attestations'));
api.get('/profile/:id', paidGate, noopBalance, stubHandler('profile'));
api.post('/probe', paidGate, noopBalance, stubHandler('probe'));
app.use('/api', api);

// Side-channel : settle une invoice (simulation paiement)
app.post('/_test/settle/:rHashHex', (req, res) => {
  const inv = lnd.invoices.get(req.params.rHashHex);
  if (!inv) {
    res.status(404).json({ error: 'invoice not found' });
    return;
  }
  inv.settled = true;
  res.json({ settled: true, preimage: inv.preimageHex, valueSat: inv.valueSat });
});

// Side-channel : dernier invoice emis (pour recuperer le preimage en shell)
app.get('/_test/last-invoice', (_req, res) => {
  if (!lnd.lastInvoice) {
    res.status(404).json({ error: 'no invoice yet' });
    return;
  }
  res.json({
    rHashHex: lnd.lastInvoice.rHashHex,
    preimage: lnd.lastInvoice.preimageHex,
    valueSat: lnd.lastInvoice.valueSat,
    settled: lnd.lastInvoice.settled,
  });
});

// Error handler final — expose les erreurs en JSON plutot qu'un HTML Express
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
});

app.listen(PORT, () => {
  process.stdout.write(`\n[l402TestServer] listening on :${PORT}\n`);
  process.stdout.write(`[l402TestServer] l402Native ${L402_ENABLED ? 'ENABLED' : 'DISABLED (noop gate)'}\n`);
  process.stdout.write(`[l402TestServer] secret=${SECRET_HEX.slice(0, 8)}...${SECRET_HEX.slice(-8)}\n`);
});
