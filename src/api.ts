// SatRank V3 — HTTP API. Five routes.
//
// 1. POST /api/intent              — paid (2 sats via L402) ; returns ranked candidates
// 2. GET  /api/services/:url_hash  — endpoint score snapshot
// 3. GET  /api/services/categories — list of known categories
// 4. GET  /api/services/best       — top-3 per category
// 5. GET  /api/oracle/budget       — last 24h revenue + paid-probe spend

import express, { type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { logger } from './logger.js';
import { pool } from './db.js';
import { rank, scoreEndpoint } from './scoring.js';
import { addInvoice, lndEnabled } from './lnd.js';
import { oraclePubkey } from './nostr.js';
import type { IntentRequest, IntentCandidate, EndpointScore } from './types.js';
import { STAGES } from './types.js';

// --- L402 native gate -------------------------------------------------------

interface L402Token {
  payment_hash: string;
  expires_at: number;
}

function l402Hmac(payload: string): string {
  if (!config.L402_MACAROON_SECRET) throw new Error('L402_MACAROON_SECRET not set');
  return crypto
    .createHmac('sha256', Buffer.from(config.L402_MACAROON_SECRET, 'hex'))
    .update(payload)
    .digest('hex');
}

function buildMacaroon(payment_hash: string, expires_at: number): string {
  const payload = `${payment_hash}:${expires_at}`;
  const sig = l402Hmac(payload);
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function verifyMacaroon(macaroon: string): L402Token | null {
  try {
    const decoded = Buffer.from(macaroon, 'base64url').toString('utf8');
    const lastDot = decoded.lastIndexOf('.');
    if (lastDot < 0) return null;
    const payload = decoded.slice(0, lastDot);
    const sig = decoded.slice(lastDot + 1);
    if (l402Hmac(payload) !== sig) return null;
    const [payment_hash, expiresStr] = payload.split(':');
    const expires_at = Number(expiresStr);
    if (!payment_hash || !expires_at || expires_at < Math.floor(Date.now() / 1000)) return null;
    return { payment_hash, expires_at };
  } catch {
    return null;
  }
}

/** L402 paid-gate middleware. On miss → 402 with a fresh invoice. On hit →
 *  next() through with the verified payment_hash on req.l402. */
function paidGate(price_sats: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!lndEnabled() || !config.L402_MACAROON_SECRET) {
      return res.status(503).json({ error: { code: 'L402_NOT_CONFIGURED', message: 'paid gate disabled' } });
    }
    const auth = req.header('authorization') ?? '';
    const m = auth.match(/^L402\s+([^:]+):([a-f0-9]{64})$/);
    if (m) {
      const tok = verifyMacaroon(m[1]);
      const preimage = m[2];
      const ph = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
      if (tok && tok.payment_hash === ph) {
        // Confirm preimage settles the invoice. We don't re-query LND on every
        // request — payment_hash binding is enough since the preimage came in
        // and we can re-derive sha256(preimage) ourselves.
        await pool.query(
          `INSERT INTO revenue_log (payment_hash, route, sats_received, received_at)
           VALUES ($1, $2, $3, $4) ON CONFLICT (payment_hash) DO NOTHING`,
          [ph, req.path, price_sats, Math.floor(Date.now() / 1000)],
        );
        (req as Request & { l402?: { payment_hash: string } }).l402 = { payment_hash: ph };
        return next();
      }
    }
    // Mint a fresh invoice + macaroon.
    try {
      const inv = await addInvoice(price_sats, `SatRank ${req.path}`, 600);
      const expires_at = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
      const macaroon = buildMacaroon(inv.payment_hash, expires_at);
      res.set('WWW-Authenticate', `L402 macaroon="${macaroon}", invoice="${inv.payment_request}"`);
      res.status(402).json({ error: { code: 'PAYMENT_REQUIRED', message: `${price_sats} sats` } });
    } catch (err: unknown) {
      logger.error({ err: (err as Error).message }, 'l402: addInvoice failed');
      res.status(503).json({ error: { code: 'L402_INVOICE_FAILED' } });
    }
  };
}

// --- Schemas ----------------------------------------------------------------

const intentSchema = z.object({
  category: z.string().min(1).max(64),
  keywords: z.array(z.string().min(1).max(40)).max(10).optional(),
  budget_sats: z.number().int().min(1).max(10_000).optional(),
  max_latency_ms: z.number().int().min(1).max(60_000).optional(),
  optimize: z.enum(['p_success', 'latency', 'cost']).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

// --- Helpers ----------------------------------------------------------------

function toCandidate(s: EndpointScore): IntentCandidate {
  return {
    url: s.url,
    url_hash: s.url_hash,
    category: s.category,
    name: '', // filled by row JOIN below
    description: '',
    http_method: 'GET',
    price_sats: s.price_sats,
    bayesian: { p_success: s.p_e2e, ci95: [0, 1], n_obs: s.n_obs },
    stages: Object.fromEntries(
      STAGES.map((stg) => [stg, { p_success: s.stages[stg].mean, ci95: s.stages[stg].ci95 as [number, number], n: s.stages[stg].n }]),
    ) as IntentCandidate['stages'],
    median_latency_ms: s.median_latency_ms,
    is_meaningful: s.is_meaningful,
  };
}

async function hydrate(c: IntentCandidate): Promise<IntentCandidate> {
  const { rows } = await pool.query<{ name: string; description: string; http_method: string }>(
    `SELECT name, description, http_method FROM service_endpoints WHERE url_hash = $1`,
    [c.url_hash],
  );
  if (rows.length > 0) {
    c.name = rows[0].name;
    c.description = rows[0].description;
    c.http_method = rows[0].http_method;
  }
  return c;
}

// --- Routes -----------------------------------------------------------------

export function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/.well-known/satrank-key', (_req, res) => {
    if (!config.NOSTR_PRIVATE_KEY) return res.status(503).json({ error: 'oracle key not configured' });
    res.json({ pubkey: oraclePubkey() });
  });

  const api = express.Router();

  // 1. POST /api/intent — paid 2 sats.
  api.post('/intent', paidGate(config.L402_INTENT_PRICE_SATS), async (req, res, next) => {
    try {
      const parse = intentSchema.safeParse(req.body);
      if (!parse.success) return res.status(400).json({ error: { code: 'INVALID_PAYLOAD', issues: parse.error.issues } });
      const intent: IntentRequest = parse.data;
      const ranked = await rank({
        category: intent.category,
        budget_sats: intent.budget_sats,
        max_latency_ms: intent.max_latency_ms,
        optimize: intent.optimize,
        limit: intent.limit,
      });
      const candidates = await Promise.all(ranked.map((s) => hydrate(toCandidate(s))));
      res.json({ data: { candidates, count: candidates.length } });
    } catch (err) {
      next(err);
    }
  });

  // 2. GET /api/services/categories — list categories from the catalogue.
  // (Mounted before /services/:url_hash so Express matches the literal path
  //  first ; otherwise `categories` would be parsed as a url_hash param.)
  api.get('/services/categories', async (_req, res, next) => {
    try {
      const { rows } = await pool.query<{ category: string; count: number }>(
        `SELECT category, COUNT(*)::int AS count
           FROM service_endpoints GROUP BY category ORDER BY count DESC`,
      );
      res.json({ data: rows });
    } catch (err) {
      next(err);
    }
  });

  // 3. GET /api/services/best — top 3 per category, free read.
  // (Mounted before /services/:url_hash so Express matches the literal path
  //  first ; otherwise `best` would be parsed as a url_hash param.)
  api.get('/services/best', async (_req, res, next) => {
    try {
      const { rows } = await pool.query<{ category: string }>(
        `SELECT DISTINCT category FROM service_endpoints LIMIT 50`,
      );
      const out: Record<string, IntentCandidate[]> = {};
      for (const r of rows) {
        const ranked = await rank({ category: r.category, limit: 3 });
        out[r.category] = await Promise.all(ranked.map((s) => hydrate(toCandidate(s))));
      }
      res.json({ data: out });
    } catch (err) {
      next(err);
    }
  });

  // 4. GET /api/services/:url_hash — score snapshot.
  api.get('/services/:url_hash', async (req, res, next) => {
    try {
      const url_hash = String(req.params.url_hash);
      if (!/^[a-f0-9]{64}$/.test(url_hash)) {
        return res.status(400).json({ error: { code: 'INVALID_URL_HASH' } });
      }
      const score = await scoreEndpoint(url_hash);
      if (!score) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
      const c = await hydrate(toCandidate(score));
      res.json({ data: c });
    } catch (err) {
      next(err);
    }
  });

  // 5. GET /api/oracle/budget — last 24h revenue + paid-probe spend.
  api.get('/oracle/budget', async (_req, res, next) => {
    try {
      const since = Math.floor(Date.now() / 1000) - 86400;
      const [{ rows: rev }, { rows: spent }] = await Promise.all([
        pool.query<{ sum: number | null }>(
          `SELECT SUM(sats_received)::bigint AS sum FROM revenue_log WHERE received_at >= $1`,
          [since],
        ),
        pool.query<{ sum: number | null }>(
          `SELECT SUM(invoice_sats)::bigint AS sum FROM paid_probe_results WHERE paid_at >= $1`,
          [since],
        ),
      ]);
      const revenue = Number(rev[0].sum ?? 0);
      const spending = Number(spent[0].sum ?? 0);
      res.json({
        data: {
          since,
          revenue_sats: revenue,
          probe_spend_sats: spending,
          coverage_ratio: spending > 0 ? revenue / spending : null,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.use('/api', api);

  // Final error handler. JSON envelope.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: err.message, stack: err.stack }, 'api: unhandled');
    if (res.headersSent) return;
    res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
  });

  return app;
}
