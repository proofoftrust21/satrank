// L402 native middleware — Phase 14D.3.0 (deployed 2026-04-23).
//
// Implementation native Express du protocole L402 (remplace le reverse proxy
// externe qui tournait sur :8082). Le middleware gere trois branches :
//
//   1. Pas d'Authorization header       -> 402 + challenge (invoice + macaroon)
//   2. Authorization L402 deposit:...   -> passe-plat (balanceAuth traite)
//   3. Authorization L402 <mac>:<pre>   -> verification macaroon + preimage
//                                          + settled LND (first-use uniquement)
//
// Format macaroon : base64url(JSON payload) + "." + base64url(HMAC-SHA256)
// Payload v1 : { v:1, ph, ca, ps, rt, tt } (voir src/utils/macaroonHmac.ts)
//
// Rotation du secret L402_MACAROON_SECRET :
//   1. openssl rand -hex 32 genere une nouvelle valeur 64 chars hex
//   2. injecter via .env.production (jamais rsync --delete)
//   3. redemarrer le container api (un seul secret actif a la fois - les
//      macaroons emis sous l'ancien secret deviennent INVALID apres rotation,
//      ce qui force la remission via 402. C'est souhaite : pas de sliding
//      window pour eviter la fenetre de validite d'une clef compromise).
//   4. .rsync-exclude doit proteger .env* (deja le cas Phase 7).
//
// Interactions avec balanceAuth (middleware suivant dans la chaine) :
//   - auto-create de token_balance : delegue a balanceAuth
//   - debit 1 sat/requete : delegue a balanceAuth
//   - headers X-SatRank-Balance / X-SatRank-Balance-Max : delegue a balanceAuth

import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import { logger } from '../logger';
import { encodeMacaroon, verifyMacaroon, type MacaroonPayload } from '../utils/macaroonHmac';
import { LndInvoiceService } from '../services/lndInvoiceService';
import { safeEqual } from './auth';

export interface L402NativeOptions {
  /** Secret HMAC 32 octets pour signer/verifier les macaroons. */
  secret: Buffer;
  /** Service LND (addInvoice + lookupInvoice). */
  lndInvoice: LndInvoiceService;
  /** Pool PostgreSQL (pour la check de presence du token). */
  pool: Pool;
  /** Prix par defaut du challenge en sats (fallback quand pricingMap ne
   *  matche pas). */
  priceSats: number;
  /** TTL du macaroon en secondes (30 jours par defaut). */
  ttlSeconds: number;
  /** Duree de vie de l'invoice BOLT11 en secondes. */
  expirySeconds: number;
  /** Mapping pattern-route Express -> prix en sats. Ex. :
   *  { '/probe': 5, '/agent/:publicKeyHash': 1 }. Cle = req.route?.path
   *  (sans prefixe /api car le router est monte sous /api). Si aucune cle
   *  ne matche la route courante, priceSats (fallback) est utilise. */
  pricingMap?: Record<string, number>;
  /** Secret operator (X-Operator-Token). Match timing-safe => passe-plat du
   *  gate L402. Undefined => branche desactivee. */
  operatorSecret?: string;
  /** Phase 6.4 — callback optional firing après l'acceptation du first-use
   *  paiement L402. Reçoit (route, priceSats, paymentHash). Permet de
   *  logger le revenue dans oracle_revenue_log sans coupler le middleware
   *  au service qui suit. Erreurs swallowed (logger uniquement) — la
   *  comptabilité ne doit pas bloquer la requête. */
  onPaidCallSettled?: (route: string, priceSats: number, paymentHash: string) => Promise<void>;
}

interface L402ErrorBody {
  error: { code: string; message: string };
}

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 jours

function send402Challenge(
  res: Response,
  macaroon: string,
  invoice: string,
  paymentHashHex: string,
  priceSats: number,
  expiresIn: number,
): void {
  res
    .setHeader('WWW-Authenticate', `L402 macaroon="${macaroon}", invoice="${invoice}"`)
    .status(402)
    .json({
      error: {
        code: 'PAYMENT_REQUIRED',
        message: 'L402 payment required. Pay the invoice, then retry with Authorization: L402 <macaroon>:<preimage>.',
      },
      data: {
        paymentHash: paymentHashHex,
        priceSats,
        expiresIn,
        invoice,
        macaroon,
      },
    });
}

function sendError(res: Response, status: number, code: string, message: string): void {
  const body: L402ErrorBody = { error: { code, message } };
  res.status(status).json(body);
}

function resolvePrice(req: Request, opts: L402NativeOptions): number {
  const routePath = req.route?.path;
  if (routePath && opts.pricingMap && opts.pricingMap[routePath] !== undefined) {
    return opts.pricingMap[routePath];
  }
  return opts.priceSats;
}

export function createL402Native(opts: L402NativeOptions) {
  const ttl = opts.ttlSeconds > 0 ? opts.ttlSeconds : DEFAULT_TTL_SECONDS;

  return async function l402Native(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const authHeader = req.headers.authorization ?? '';

      // Operator bypass — used by SatRank operator for admin tests and CI/CD
      // health checks. If OPERATOR_BYPASS_SECRET leaks, attacker gets
      // unlimited free access to paid endpoints. Rotate via :
      //   openssl rand -hex 32 -> update .env.production -> rebuild + restart api.
      // balanceAuth downstream skip aussi car pas de header L402/LSAT dans ce
      // path. Pas de log (undocumented admin backdoor).
      if (opts.operatorSecret) {
        const provided = req.headers['x-operator-token'];
        if (typeof provided === 'string' && provided.length > 0 && safeEqual(provided, opts.operatorSecret)) {
          next();
          return;
        }
      }

      // Branche 2 — deposit tokens : balanceAuth gere la verification et le
      // debit via balance_credits. Pas de macaroon HMAC a verifier (le preimage
      // hache est la seule preuve, son existence en DB signifie paiement deja
      // verifie par depositController).
      if (/^L402\s+deposit:/i.test(authHeader)) {
        next();
        return;
      }

      // Branche 1 — pas d'Authorization : mint un challenge 402.
      if (!authHeader.startsWith('L402 ') && !authHeader.startsWith('LSAT ')) {
        if (!opts.lndInvoice.isAvailable()) {
          sendError(res, 503, 'SERVICE_UNAVAILABLE', 'L402 challenge generation unavailable (LND invoice macaroon not loaded)');
          return;
        }
        const priceSats = resolvePrice(req, opts);
        const memo = `SatRank L402 ${req.path}`;
        const invoice = await opts.lndInvoice.addInvoice(priceSats, memo, opts.expirySeconds);
        const paymentHashHex = Buffer.from(invoice.r_hash, 'base64').toString('hex');
        const payload: MacaroonPayload = {
          v: 1,
          ph: paymentHashHex,
          ca: Math.floor(Date.now() / 1000),
          ps: priceSats,
          rt: req.path.slice(0, 200),
          tt: ttl,
        };
        const macaroon = encodeMacaroon(payload, opts.secret);
        send402Challenge(res, macaroon, invoice.payment_request, paymentHashHex, priceSats, opts.expirySeconds);
        return;
      }

      // Branche 3 — macaroon + preimage attendus.
      const headerMatch = /^(?:L402|LSAT)\s+(\S+):([a-f0-9]{64})$/i.exec(authHeader);
      if (!headerMatch) {
        sendError(res, 401, 'INVALID_AUTH', 'Malformed L402 Authorization header. Expected: L402 <macaroon>:<preimage_hex>');
        return;
      }
      const macaroonB64 = headerMatch[1];
      const preimageHex = headerMatch[2];

      // Verification HMAC + version + TTL
      const verifyResult = verifyMacaroon(macaroonB64, opts.secret);
      if (!verifyResult.ok) {
        const status = verifyResult.error === 'EXPIRED' ? 401 : 401;
        sendError(res, status, verifyResult.error, `Macaroon ${verifyResult.error.toLowerCase()}`);
        return;
      }
      const payload = verifyResult.payload;

      // Verification preimage hash == payload.ph (timing-safe)
      const computedHash = crypto.createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest();
      const expectedHash = Buffer.from(payload.ph, 'hex');
      if (
        computedHash.length !== expectedHash.length ||
        !crypto.timingSafeEqual(computedHash, expectedHash)
      ) {
        sendError(res, 401, 'PREIMAGE_MISMATCH', 'Preimage does not match macaroon payment_hash');
        return;
      }

      // First-use check : si le token est deja enregistre en DB, balanceAuth
      // prend le relais (debit). Sinon on LND-lookup pour verifier le paiement
      // avant de laisser balanceAuth auto-creer le row.
      const paymentHashBuf = expectedHash;
      const existing = await opts.pool.query(
        'SELECT payment_hash FROM token_balance WHERE payment_hash = $1',
        [paymentHashBuf],
      );
      if (existing.rows.length > 0) {
        next();
        return;
      }

      // First use : verifier que l'invoice est settled avant d'autoriser
      // l'auto-create dans balanceAuth. Sans ce check, un preimage forge avec
      // un macaroon valide donnerait 1 requete gratuite (auto-create =
      // TOKEN_QUOTA - 1 = 0 pour TOKEN_QUOTA = 1, mais la requete courante
      // passe).
      if (!opts.lndInvoice.isAvailable()) {
        sendError(res, 503, 'SERVICE_UNAVAILABLE', 'L402 verification unavailable (LND invoice macaroon not loaded)');
        return;
      }
      const invoice = await opts.lndInvoice.lookupInvoice(payload.ph);
      if (!invoice.settled) {
        sendError(res, 402, 'PAYMENT_PENDING', 'Invoice not yet settled. Pay the invoice before retrying.');
        return;
      }

      // Token valide + paiement confirme : balanceAuth auto-creera le row.
      logger.info({ paymentHash: payload.ph.slice(0, 16), route: payload.rt, priceSats: payload.ps }, 'L402 native first-use accepted');
      // Phase 6.4 — log revenue. Fire-and-forget : la requête ne doit pas
      // bloquer sur la compta. Erreurs swallowed avec un warn pour audit.
      if (opts.onPaidCallSettled) {
        opts
          .onPaidCallSettled(payload.rt, payload.ps, payload.ph)
          .catch((err) => {
            logger.warn(
              { error: err instanceof Error ? err.message : String(err), paymentHash: payload.ph.slice(0, 16) },
              'L402 onPaidCallSettled callback failed (non-fatal)',
            );
          });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
