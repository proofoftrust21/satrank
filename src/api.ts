// SatRank V3 — HTTP API. Twelve routes (3 doc + 9 functional).
//
// Doc surface:
//   GET  /                          — landing (static HTML)
//   GET  /methodology               — methodology reference (static HTML)
//   GET  /api                       — API reference (static HTML)
//   GET  /openapi.json              — OpenAPI 3.0 spec (machine-readable)
//
// Functional surface:
//   GET  /health                    — liveness
//   GET  /.well-known/satrank-key   — oracle Schnorr pubkey
//   POST /api/deposit               — mint multi-use deposit macaroon
//   GET  /api/deposit/:macaroon_id  — read remaining balance
//   POST /api/intent                — paid (2 sats via L402) ; ranked candidates
//   GET  /api/services/:url_hash    — endpoint score snapshot
//   GET  /api/services/categories   — list of known categories
//   GET  /api/services/best         — top-3 per category (5-min cache)
//   GET  /api/oracle/budget         — last 24h revenue + paid-probe spend

import express, { type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
    // Constant-time compare — naive `!==` short-circuits on the first
    // differing character, leaking byte-by-byte timing info to a remote
    // attacker. `timingSafeEqual` requires equal-length Buffers.
    const expected = Buffer.from(l402Hmac(payload), 'hex');
    const actual = Buffer.from(sig, 'hex');
    if (expected.length !== actual.length) return null;
    if (!crypto.timingSafeEqual(expected, actual)) return null;
    const [payment_hash, expiresStr] = payload.split(':');
    const expires_at = Number(expiresStr);
    if (!payment_hash || !expires_at || expires_at < Math.floor(Date.now() / 1000)) return null;
    return { payment_hash, expires_at };
  } catch {
    return null;
  }
}

/** Try to consume `price_sats` from a deposit credit identified by macaroon_id,
 *  authenticated by the bearer preimage. Atomic single-statement decrement
 *  via UPDATE … RETURNING avoids race conditions when an agent makes
 *  concurrent calls. Returns:
 *    - 'ok'              : decrement succeeded, agent should be granted access
 *    - 'unknown'         : macaroon_id not found
 *    - 'wrong_preimage'  : preimage doesn't match the issued payment_hash
 *    - 'expired'         : macaroon TTL elapsed
 *    - 'insufficient'    : sats_remaining < price
 */
async function consumeDeposit(macaroon_id: string, preimage_hex: string, price_sats: number): Promise<
  'ok' | 'unknown' | 'wrong_preimage' | 'expired' | 'insufficient'
> {
  const ph = crypto.createHash('sha256').update(Buffer.from(preimage_hex, 'hex')).digest('hex');
  const now = Math.floor(Date.now() / 1000);
  // Atomic guard : the WHERE clause filters out unknown / wrong_preimage /
  // expired / insufficient so the UPDATE is a no-op for those cases.
  // RETURNING gives us the new sats_remaining for response shaping.
  const { rows } = await pool.query<{ payment_hash: string; expires_at: number; sats_remaining: number }>(
    `UPDATE agent_credits
        SET sats_remaining = sats_remaining - $3,
            activated_at = COALESCE(activated_at, $4)
      WHERE macaroon_id = $1
        AND payment_hash = $2
        AND expires_at > $4
        AND sats_remaining >= $3
      RETURNING payment_hash, expires_at, sats_remaining`,
    [macaroon_id, ph, price_sats, now],
  );
  if (rows.length > 0) return 'ok';
  // Diagnostic : peek at the row to figure out which precondition failed.
  // Cheap (one indexed lookup) and the deposit path is per-request, not hot.
  const { rows: peek } = await pool.query<{ payment_hash: string; expires_at: number; sats_remaining: number }>(
    `SELECT payment_hash, expires_at, sats_remaining FROM agent_credits WHERE macaroon_id = $1`,
    [macaroon_id],
  );
  if (peek.length === 0) return 'unknown';
  if (peek[0].payment_hash !== ph) return 'wrong_preimage';
  if (peek[0].expires_at <= now) return 'expired';
  return 'insufficient';
}

/** L402 paid-gate middleware. On miss → 402 with a fresh invoice. On hit →
 *  next() through with the verified payment_hash on req.l402.
 *
 *  Two auth shapes are accepted:
 *    - L402 <macaroon>:<preimage>            (single-use, V3 default)
 *    - L402 deposit_<id>:<preimage>          (multi-use deposit credit)
 *  See POST /api/deposit for the deposit lifecycle. */
function paidGate(price_sats: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!lndEnabled() || !config.L402_MACAROON_SECRET) {
      return res.status(503).json({ error: { code: 'L402_NOT_CONFIGURED', message: 'paid gate disabled' } });
    }
    const auth = req.header('authorization') ?? '';
    const m = auth.match(/^L402\s+([^:]+):([a-f0-9]{64})$/);
    if (m) {
      const macStr = m[1];
      const preimage = m[2];

      // --- Path A : deposit credit (multi-use) ---
      if (macStr.startsWith('deposit_')) {
        const macaroon_id = macStr.slice('deposit_'.length);
        if (!/^[a-f0-9]{64}$/.test(macaroon_id)) {
          return res.status(401).json({ error: { code: 'INVALID_MACAROON_ID' } });
        }
        try {
          const r = await consumeDeposit(macaroon_id, preimage, price_sats);
          if (r === 'ok') {
            (req as Request & { l402?: { macaroon_id: string } }).l402 = { macaroon_id };
            return next();
          }
          if (r === 'unknown' || r === 'wrong_preimage') {
            return res.status(401).json({ error: { code: 'DEPOSIT_AUTH_FAILED' } });
          }
          if (r === 'expired') {
            return res.status(402).json({ error: { code: 'DEPOSIT_EXPIRED', message: 'top up at POST /api/deposit' } });
          }
          // insufficient
          return res.status(402).json({ error: { code: 'DEPOSIT_INSUFFICIENT', message: `top up ; need ${price_sats} sats` } });
        } catch (err: unknown) {
          logger.error({ err: (err as Error).message }, 'l402: consumeDeposit threw');
          return res.status(503).json({ error: { code: 'INTERNAL_ERROR' } });
        }
      }

      // --- Path B : single-use L402 macaroon ---
      const tok = verifyMacaroon(macStr);
      const ph = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
      if (tok && tok.payment_hash === ph) {
        try {
          const { rowCount } = await pool.query(
            `INSERT INTO revenue_log (payment_hash, route, sats_received, received_at)
             VALUES ($1, $2, $3, $4) ON CONFLICT (payment_hash) DO NOTHING`,
            [ph, req.path, price_sats, Math.floor(Date.now() / 1000)],
          );
          if ((rowCount ?? 0) === 0) {
            return res.status(402).json({
              error: { code: 'PAYMENT_ALREADY_USED', message: 'this preimage was already redeemed; pay a fresh invoice or use POST /api/deposit for multi-use credit' },
            });
          }
        } catch (dbErr: unknown) {
          logger.error({ err: (dbErr as Error).message }, 'l402: revenue_log insert failed');
          return res.status(503).json({ error: { code: 'INTERNAL_ERROR', message: 'database unavailable' } });
        }
        (req as Request & { l402?: { payment_hash: string } }).l402 = { payment_hash: ph };
        return next();
      }
    }
    // Mint a fresh single-use invoice + macaroon. Agents who want multi-use
    // should hit POST /api/deposit instead — see the X-L402-Hint header.
    try {
      const inv = await addInvoice(price_sats, `SatRank ${req.path}`, 600);
      const expires_at = Math.floor(Date.now() / 1000) + 600;
      const macaroon = buildMacaroon(inv.payment_hash, expires_at);
      res.set('WWW-Authenticate', `L402 macaroon="${macaroon}", invoice="${inv.payment_request}"`);
      res.set('X-L402-Hint', 'multi-use credit available at POST /api/deposit');
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

const depositSchema = z.object({
  // Min 10 = at least 5 paid intent calls at the default 2-sat price.
  // Max 10000 = pre-purchase ceiling that maps to ~5000 calls.
  sats: z.number().int().min(10).max(10_000),
});

const DEPOSIT_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

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

// --- Rate limiters ----------------------------------------------------------
//
// nginx fronts the API on 127.0.0.1:3000 — only one trusted proxy hop. With
// `trust proxy = 1`, req.ip resolves to the real client IP via X-Forwarded-For
// instead of the loopback. Without it, every limiter would bucket the entire
// world as 127.0.0.1.

const globalLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED' } },
});

const intentLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED' } },
});

// --- /services/best response cache -----------------------------------------
//
// /services/best is unauthenticated and free, but a single call fans out
// into ≤ 30 000 DB queries (50 categories × 200 candidates × 3 queries
// each). 5-minute cache caps the actual DB cost at 12 / hour regardless
// of HTTP traffic.

const BEST_CACHE_TTL_MS = 5 * 60 * 1000;
let bestCache: { data: Record<string, IntentCandidate[]>; ts: number } | null = null;

// --- Routes -----------------------------------------------------------------

export function buildApp(): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));
  app.use(globalLimiter);

  // Static pages + machine spec. Read once from disk at boot — sub-millisecond
  // reply. The build script copies src/*.html and src/openapi.json to dist/
  // alongside the compiled JS, so paths resolve the same way in dev (tsx)
  // and prod.
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  const landingHtml = fs.readFileSync(path.join(distDir, 'landing.html'), 'utf8');
  const methodologyHtml = fs.readFileSync(path.join(distDir, 'methodology.html'), 'utf8');
  const apiReferenceHtml = fs.readFileSync(path.join(distDir, 'api-reference.html'), 'utf8');
  const openapiJson = fs.readFileSync(path.join(distDir, 'openapi.json'), 'utf8');

  function serveHtml(html: string) {
    return (_req: Request, res: Response): void => {
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=300');
      res.send(html);
    };
  }

  app.get('/', serveHtml(landingHtml));
  app.get('/methodology', serveHtml(methodologyHtml));
  app.get('/api', serveHtml(apiReferenceHtml));
  app.get('/openapi.json', (_req, res) => {
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(openapiJson);
  });

  // V1 URL aliases — keep external backlinks alive.
  app.get('/methodology.html', (_req, res) => res.redirect(301, '/methodology'));
  app.get('/docs', (_req, res) => res.redirect(301, '/api'));
  app.get('/docs.html', (_req, res) => res.redirect(301, '/api'));
  app.get('/api/docs', (_req, res) => res.redirect(301, '/api'));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/.well-known/satrank-key', (_req, res) => {
    if (!config.NOSTR_PRIVATE_KEY) return res.status(503).json({ error: 'oracle key not configured' });
    res.json({ pubkey: oraclePubkey() });
  });

  const api = express.Router();

  // 0. POST /api/deposit — pre-pay N sats once, get a multi-use macaroon.
  // The macaroon authenticates subsequent /api/intent calls via
  //   `Authorization: L402 deposit_<macaroon_id>:<preimage_hex>`
  // until sats_remaining < intent_price or the 30-day TTL elapses.
  // The route itself is free (no paidGate) ; the agent only "pays" when
  // they settle the returned BOLT11 via their own wallet.
  api.post('/deposit', async (req, res, next) => {
    try {
      if (!lndEnabled()) {
        return res.status(503).json({ error: { code: 'L402_NOT_CONFIGURED' } });
      }
      const parse = depositSchema.safeParse(req.body);
      if (!parse.success) {
        return res.status(400).json({ error: { code: 'INVALID_PAYLOAD', issues: parse.error.issues } });
      }
      const sats = parse.data.sats;
      const issued_at = Math.floor(Date.now() / 1000);
      const expires_at = issued_at + DEPOSIT_TTL_SEC;
      const macaroon_id = crypto.randomBytes(32).toString('hex');
      const inv = await addInvoice(sats, `SatRank deposit ${macaroon_id.slice(0, 8)}`, DEPOSIT_TTL_SEC);
      try {
        await pool.query(
          `INSERT INTO agent_credits (macaroon_id, payment_hash, sats_initial, sats_remaining, issued_at, expires_at)
           VALUES ($1, $2, $3, $3, $4, $5)`,
          [macaroon_id, inv.payment_hash, sats, issued_at, expires_at],
        );
      } catch (dbErr: unknown) {
        logger.error({ err: (dbErr as Error).message }, 'deposit: insert failed');
        return res.status(503).json({ error: { code: 'INTERNAL_ERROR' } });
      }
      res.json({
        data: {
          macaroon: `deposit_${macaroon_id}`,
          invoice: inv.payment_request,
          payment_hash: inv.payment_hash,
          sats,
          expires_at,
          ttl_sec: DEPOSIT_TTL_SEC,
          usage_hint: `Pay the invoice with your Lightning wallet, then send subsequent /api/intent calls with header: Authorization: L402 deposit_${macaroon_id}:<preimage_hex>`,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // 0b. GET /api/deposit/:macaroon_id — public read of the credit's
  //     activation + remaining balance + expiry. Doesn't expose the
  //     payment_hash or any auth secret. Useful for the agent to know
  //     "how many calls do I have left ?" without making an /intent call.
  api.get('/deposit/:macaroon_id', async (req, res, next) => {
    try {
      const id = String(req.params.macaroon_id).replace(/^deposit_/, '');
      if (!/^[a-f0-9]{64}$/.test(id)) {
        return res.status(400).json({ error: { code: 'INVALID_MACAROON_ID' } });
      }
      const { rows } = await pool.query<{
        sats_initial: number; sats_remaining: number; issued_at: number;
        activated_at: number | null; expires_at: number;
      }>(
        `SELECT sats_initial, sats_remaining, issued_at, activated_at, expires_at
           FROM agent_credits WHERE macaroon_id = $1`,
        [id],
      );
      if (rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
      const r = rows[0];
      res.json({
        data: {
          macaroon_id: id,
          sats_initial: r.sats_initial,
          sats_remaining: r.sats_remaining,
          issued_at: Number(r.issued_at),
          activated_at: r.activated_at !== null ? Number(r.activated_at) : null,
          expires_at: Number(r.expires_at),
          // Agents read this to gauge fresh activation : true once the first
          // /api/intent call has succeeded with the matching preimage.
          activated: r.activated_at !== null,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // 1. POST /api/intent — paid 2 sats.
  api.post('/intent', intentLimiter, paidGate(config.L402_INTENT_PRICE_SATS), async (req, res, next) => {
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
      // Unnest category_tags so a service listed under {video, streaming,
      // content} appears in three buckets — agents see the full taxonomy
      // they can query, not just the per-endpoint primary tag.
      const { rows } = await pool.query<{ category: string; count: number }>(
        `SELECT tag AS category, COUNT(*)::int AS count
           FROM service_endpoints, unnest(category_tags) AS tag
          GROUP BY tag ORDER BY count DESC`,
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
      if (bestCache && Date.now() - bestCache.ts < BEST_CACHE_TTL_MS) {
        return res.json({ data: bestCache.data });
      }
      const { rows } = await pool.query<{ category: string }>(
        `SELECT DISTINCT tag AS category
           FROM service_endpoints, unnest(category_tags) AS tag LIMIT 50`,
      );
      const out: Record<string, IntentCandidate[]> = {};
      for (const r of rows) {
        const ranked = await rank({ category: r.category, limit: 3 });
        out[r.category] = await Promise.all(ranked.map((s) => hydrate(toCandidate(s))));
      }
      bestCache = { data: out, ts: Date.now() };
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
