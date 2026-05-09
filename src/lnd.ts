// SatRank V3 — minimal LND REST client.
//
// Three operations: addInvoice, payInvoice, decodePayReq. Macaroon header.
// TLS cert ignored if pointed at a trusted host (e.g. localhost over Unix socket
// proxied via stunnel). Production deployments should bake the cert into NODE_EXTRA_CA_CERTS.

import { readFileSync } from 'node:fs';
import { Agent } from 'node:https';
import { config } from './config.js';
import { logger } from './logger.js';

/** Resolve the macaroon: either LND_MACAROON_HEX (preferred) or read the
 *  binary file at LND_MACAROON_PATH and hex-encode it. Returns null when
 *  neither is set or the file is unreadable. */
function resolveMacaroonHex(): string | null {
  if (config.LND_MACAROON_HEX) return config.LND_MACAROON_HEX;
  if (!config.LND_MACAROON_PATH) return null;
  try {
    return readFileSync(config.LND_MACAROON_PATH).toString('hex');
  } catch (err: unknown) {
    logger.warn({ err: (err as Error).message, path: config.LND_MACAROON_PATH }, 'lnd: failed to read macaroon file');
    return null;
  }
}

const macaroonHex = resolveMacaroonHex();
const enabled = !!(config.LND_REST_URL && macaroonHex);

let httpsAgent: Agent | undefined;
if (enabled && config.LND_TLS_CERT_PATH) {
  try {
    httpsAgent = new Agent({ ca: readFileSync(config.LND_TLS_CERT_PATH) });
  } catch (err: unknown) {
    logger.warn({ err: (err as Error).message }, 'lnd: failed to load TLS cert');
  }
}

export function lndEnabled(): boolean {
  return enabled;
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
  if (!enabled) throw new Error('LND not configured');
  const url = `${config.LND_REST_URL}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      'Grpc-Metadata-macaroon': macaroonHex!,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // @ts-expect-error — Node 20+ undici exposes `dispatcher`, but we keep this
    // simple by passing through the global fetch with our agent.
    agent: httpsAgent,
  };
  const res = await fetch(url, init);
  if (!res.ok) {
    // Redact the body to a 200-char excerpt to limit log-aggregator exposure
    // of any payment/channel internals LND might surface in error responses.
    const raw = await res.text().catch(() => '[unreadable]');
    const excerpt = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
    throw new Error(`LND ${method} ${path}: HTTP ${res.status} — ${excerpt}`);
  }
  return await res.json() as T;
}

export interface DecodedInvoice {
  payment_hash: string;
  num_satoshis: number;
  description: string;
  expiry: number;
}

export async function decodePayReq(bolt11: string): Promise<DecodedInvoice> {
  const r = await call<{ payment_hash: string; num_satoshis: string; description: string; expiry: string }>(
    'GET', `/v1/payreq/${encodeURIComponent(bolt11)}`,
  );
  return {
    payment_hash: r.payment_hash,
    num_satoshis: Number(r.num_satoshis),
    description: r.description,
    expiry: Number(r.expiry),
  };
}

export interface AddInvoiceResult {
  payment_request: string;
  payment_hash: string;
  add_index: string;
}

export async function addInvoice(value_sats: number, memo: string, expiry_sec = 600): Promise<AddInvoiceResult> {
  // LND v0.18+ returns the invoice hash as `r_hash` (base64-encoded 32 bytes),
  // not as `payment_hash` hex. Normalise here so callers always see hex.
  const raw = await call<{ payment_request: string; r_hash?: string; payment_hash?: string; add_index: string }>(
    'POST', '/v1/invoices', { value: String(value_sats), memo, expiry: String(expiry_sec) },
  );
  const payment_hash = raw.payment_hash
    ?? (raw.r_hash ? Buffer.from(raw.r_hash, 'base64').toString('hex') : '');
  if (!payment_hash) throw new Error('LND addInvoice: response missing both payment_hash and r_hash');
  return { payment_request: raw.payment_request, payment_hash, add_index: raw.add_index };
}

export interface PayInvoiceResult {
  payment_preimage: string;
  payment_error: string;
  payment_hash: string;
}

export async function payInvoice(bolt11: string, max_fee_sats = 10): Promise<PayInvoiceResult> {
  // Note: /v1/channels/transactions is the legacy synchronous-pay endpoint.
  // Newer LND builds dropped the `timeout_seconds` field from this v1 schema
  // (it lives only on /v2/router/send now). Keep the body minimal so we
  // remain compatible across LND 0.17 → 0.20+.
  //
  // Encoding gotcha: LND REST returns `payment_preimage` and `payment_hash`
  // base64-encoded by default (32 raw bytes → 44-char base64 string). The
  // L402 protocol mandates the bearer header carries a 64-char hex string:
  //
  //     Authorization: L402 <macaroon_b64>:<preimage_hex>
  //
  // If we forward the base64 verbatim, every L402 endpoint rejects with
  // 402 "Invalid preimage" because sha256(base64_string_bytes) ≠ payment_hash.
  // Diagnosed 2026-05-09 via manual probe of l402.services/ln/search:
  // 100% of paid probes had delivery_ok=false because of this single bug.
  // We normalize to hex right here so callers can splice the value
  // straight into the L402 header.
  const raw = await call<PayInvoiceResult>('POST', '/v1/channels/transactions', {
    payment_request: bolt11,
    fee_limit: { fixed: String(max_fee_sats) },
  });
  return {
    payment_preimage: normaliseHex(raw.payment_preimage),
    payment_error: raw.payment_error,
    payment_hash: normaliseHex(raw.payment_hash),
  };
}

/** LND REST returns 32-byte fields as base64 by default. If the value is
 *  already valid 64-char hex, leave it alone. Otherwise treat it as base64
 *  and decode it to hex. Empty string passes through unchanged. */
function normaliseHex(value: string | undefined): string {
  if (!value) return '';
  if (/^[a-f0-9]{64}$/.test(value)) return value;
  try {
    return Buffer.from(value, 'base64').toString('hex');
  } catch {
    return value;
  }
}
