// SatRank V3 — HTTP probe.
//
// Goal: poke an endpoint, classify each of the 5 stages, ingest the
// observation. The probe is "free" by default — it stops at the L402 challenge
// and records challenge_ok/invoice_ok. With PAID_PROBE_ENABLED, it also pays
// the invoice (capped) and records payment_ok/delivery_ok/quality_ok.

import crypto from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { ingestObservation } from './scoring.js';
import { lndEnabled, decodePayReq, payInvoice } from './lnd.js';
import { pool } from './db.js';
import { assertSafeUrl, SsrfBlockedError } from './ssrf.js';
import type { Observation } from './types.js';

const TIMEOUT_MS = config.PROBE_FETCH_TIMEOUT_MS;
/** Cap response body size: a malicious endpoint streaming 10 GB would OOM
 *  the container. 256 KB is enough for any L402 JSON / text reply. */
const MAX_BODY_BYTES = 256 * 1024;

function urlHash(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex');
}

function bodyHash(body: string): string {
  return crypto.createHash('sha256').update(body).digest('hex');
}

interface FetchResult {
  status: number;
  headers: Headers;
  body: string;
  latency_ms: number;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    // Stream-read the body up to MAX_BODY_BYTES, then stop. Prevents a
    // streaming-response OOM from a malicious endpoint.
    const reader = res.body?.getReader();
    let body = '';
    if (reader) {
      const decoder = new TextDecoder();
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_BODY_BYTES) {
          await reader.cancel();
          break;
        }
        body += decoder.decode(value, { stream: true });
      }
    }
    return { status: res.status, headers: res.headers, body, latency_ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse an `Authorization: L402 <token>:<paymenthash>` challenge header.
 *  Returns the BOLT11 from the WWW-Authenticate header, or null. */
function extractInvoice(headers: Headers): string | null {
  const wwwAuth = headers.get('www-authenticate');
  if (!wwwAuth) return null;
  // L402 prefix preferred ; LSAT legacy fallback.
  const m = wwwAuth.match(/(?:L402|LSAT)\s+macaroon="([^"]+)",\s*invoice="([^"]+)"/i);
  if (!m) return null;
  return m[2];
}

/** Probe one endpoint. method+url specifies the request shape ; body optional. */
export async function probe(url: string, http_method: 'GET' | 'POST' = 'GET'): Promise<Observation> {
  const observed_at = Math.floor(Date.now() / 1000);
  const obs: Observation = {
    url_hash: urlHash(url),
    observed_at,
    challenge_ok: false,
    invoice_ok: false,
    payment_ok: null,
    delivery_ok: null,
    quality_ok: null,
    latency_ms: 0,
    http_status: null,
    body_sha256: null,
  };

  let r: FetchResult;
  try {
    await assertSafeUrl(url);
    r = await fetchWithTimeout(url, { method: http_method });
  } catch (err: unknown) {
    if (err instanceof SsrfBlockedError) {
      logger.warn({ url, err: err.message }, 'probe: SSRF guard blocked URL');
    } else {
      logger.debug({ url, err: (err as Error).message }, 'probe: fetch failed');
    }
    obs.latency_ms = TIMEOUT_MS;
    return obs;
  }
  obs.http_status = r.status;
  obs.latency_ms = r.latency_ms;

  // Stage 1 — challenge: did we get a 402 with the L402/LSAT shape?
  if (r.status !== 402) {
    return obs;
  }
  obs.challenge_ok = true;

  // Stage 2 — invoice: did the WWW-Authenticate carry a parseable invoice?
  const bolt11 = extractInvoice(r.headers);
  if (!bolt11) return obs;
  obs.invoice_ok = true;

  // Stage 3+ — only when paid probe is enabled and budget allows.
  if (!config.PAID_PROBE_ENABLED || !lndEnabled()) return obs;

  let invoice: { payment_hash: string; num_satoshis: number };
  try {
    const decoded = await decodePayReq(bolt11);
    invoice = decoded;
  } catch (err: unknown) {
    logger.warn({ url, err: (err as Error).message }, 'probe: decode failed');
    obs.payment_ok = false;
    return obs;
  }
  if (invoice.num_satoshis > config.PROBE_MAX_INVOICE_SATS) {
    logger.info({ url, sats: invoice.num_satoshis }, 'probe: invoice exceeds cap, skipping pay');
    return obs;
  }

  // Daily-budget guard: count total sats spent in the last 24h.
  const since = observed_at - 86400;
  const { rows } = await pool.query<{ sum: number | null }>(
    `SELECT SUM(invoice_sats)::bigint AS sum FROM paid_probe_results WHERE paid_at >= $1`,
    [since],
  );
  const spent = Number(rows[0].sum ?? 0);
  if (spent + invoice.num_satoshis > config.PAID_PROBE_DAILY_BUDGET_SATS) {
    logger.info({ url, spent, cap: config.PAID_PROBE_DAILY_BUDGET_SATS }, 'probe: daily budget reached');
    return obs;
  }

  let preimage: string | null = null;
  try {
    const pay = await payInvoice(bolt11, 5);
    if (pay.payment_error) {
      obs.payment_ok = false;
      logger.warn({ url, err: pay.payment_error }, 'probe: pay failed');
      return obs;
    }
    preimage = pay.payment_preimage;
    obs.payment_ok = true;
  } catch (err: unknown) {
    obs.payment_ok = false;
    logger.warn({ url, err: (err as Error).message }, 'probe: payInvoice threw');
    return obs;
  }

  await pool.query(
    `INSERT INTO paid_probe_results (payment_hash, url_hash, invoice_sats, delivery_ok, paid_at, preimage)
     VALUES ($1, $2, $3, false, $4, $5)
     ON CONFLICT (payment_hash) DO NOTHING`,
    [invoice.payment_hash, obs.url_hash, invoice.num_satoshis, observed_at, preimage],
  );

  // Stage 4 — delivery: re-call with the L402 token.
  let r2: FetchResult;
  try {
    const macaroon = (r.headers.get('www-authenticate')?.match(/macaroon="([^"]+)"/) ?? [, ''])[1];
    r2 = await fetchWithTimeout(url, {
      method: http_method,
      headers: { Authorization: `L402 ${macaroon}:${preimage}` },
    });
  } catch (err: unknown) {
    obs.delivery_ok = false;
    logger.warn({ url, err: (err as Error).message }, 'probe: delivery fetch failed');
    return obs;
  }
  obs.delivery_ok = r2.status >= 200 && r2.status < 300;
  if (obs.delivery_ok && r2.body.length > 0) {
    obs.body_sha256 = bodyHash(r2.body);
    // Stage 5 — quality: minimal heuristic (non-empty + valid JSON OR plain text).
    obs.quality_ok = r2.body.trim().length > 0;
  }

  if (obs.delivery_ok) {
    await pool.query(
      `UPDATE paid_probe_results SET delivery_ok = true WHERE payment_hash = $1`,
      [invoice.payment_hash],
    );
  }
  return obs;
}

/** Probe an endpoint and persist the observation. Convenience wrapper. */
export async function probeAndIngest(url: string, http_method: 'GET' | 'POST' = 'GET'): Promise<Observation> {
  const obs = await probe(url, http_method);
  await ingestObservation(obs);
  return obs;
}
