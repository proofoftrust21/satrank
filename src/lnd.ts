// SatRank V3 — minimal LND REST client.
//
// Three operations: addInvoice, payInvoice, decodePayReq. Macaroon header.
// TLS cert ignored if pointed at a trusted host (e.g. localhost over Unix socket
// proxied via stunnel). Production deployments should bake the cert into NODE_EXTRA_CA_CERTS.

import { readFileSync } from 'node:fs';
import { Agent } from 'node:https';
import { config } from './config.js';
import { logger } from './logger.js';

const enabled = !!(config.LND_REST_URL && config.LND_MACAROON_HEX);

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
      'Grpc-Metadata-macaroon': config.LND_MACAROON_HEX!,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // @ts-expect-error — Node 20+ undici exposes `dispatcher`, but we keep this
    // simple by passing through the global fetch with our agent.
    agent: httpsAgent,
  };
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`LND ${method} ${path}: ${res.status} ${await res.text()}`);
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
  return await call<AddInvoiceResult>('POST', '/v1/invoices', {
    value: String(value_sats),
    memo,
    expiry: String(expiry_sec),
  });
}

export interface PayInvoiceResult {
  payment_preimage: string;
  payment_error: string;
  payment_hash: string;
}

export async function payInvoice(bolt11: string, max_fee_sats = 10): Promise<PayInvoiceResult> {
  return await call<PayInvoiceResult>('POST', '/v1/channels/transactions', {
    payment_request: bolt11,
    fee_limit: { fixed: String(max_fee_sats) },
    timeout_seconds: 30,
  });
}
