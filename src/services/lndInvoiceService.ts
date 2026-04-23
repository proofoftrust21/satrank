// LND invoice service — partage la logique REST /v1/invoices + /v1/invoice/{hash}
// entre /api/deposit (achat variable) et le middleware L402 natif (Phase 14D.3.0).
//
// Macaroon "invoice-only" (pas admin) chargé au constructeur depuis un chemin
// disque. Si le macaroon manque, isAvailable() retourne false et les appelants
// doivent refuser la requete (503) au lieu de planter.

import { readFileSync } from 'fs';
import { logger } from '../logger';

export interface LndInvoiceServiceOptions {
  restUrl: string;
  macaroonPath?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface LndAddInvoiceResponse {
  r_hash: string;
  payment_request: string;
}

export interface LndLookupInvoiceResponse {
  settled: boolean;
  value: string;
  memo: string;
}

export class LndInvoiceService {
  private readonly restUrl: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;
  private invoiceMacaroonHex: string | null = null;

  constructor(opts: LndInvoiceServiceOptions) {
    this.restUrl = opts.restUrl;
    this.fetchImpl = opts.fetchImpl;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    if (opts.macaroonPath) {
      try {
        this.invoiceMacaroonHex = readFileSync(opts.macaroonPath).toString('hex');
        logger.info({ path: opts.macaroonPath }, 'Invoice macaroon loaded');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ error: msg }, 'Failed to load invoice macaroon');
      }
    }
  }

  isAvailable(): boolean {
    return this.invoiceMacaroonHex !== null;
  }

  private doFetch(url: string, init: RequestInit): Promise<Response> {
    const f = this.fetchImpl ?? globalThis.fetch;
    return f(url, init);
  }

  async addInvoice(valueSat: number, memo: string, expirySec: number): Promise<LndAddInvoiceResponse> {
    if (!this.invoiceMacaroonHex) {
      throw new Error('LND invoice macaroon not loaded');
    }
    const resp = await this.doFetch(`${this.restUrl}/v1/invoices`, {
      method: 'POST',
      headers: {
        'Grpc-Metadata-macaroon': this.invoiceMacaroonHex,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        value: String(valueSat),
        memo,
        expiry: String(expirySec),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`LND addInvoice failed: ${resp.status} ${text.slice(0, 200)}`);
    }
    return (await resp.json()) as LndAddInvoiceResponse;
  }

  async lookupInvoice(rHashHex: string): Promise<LndLookupInvoiceResponse> {
    if (!this.invoiceMacaroonHex) {
      throw new Error('LND invoice macaroon not loaded');
    }
    const resp = await this.doFetch(`${this.restUrl}/v1/invoice/${rHashHex}`, {
      headers: {
        'Grpc-Metadata-macaroon': this.invoiceMacaroonHex,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`LND lookupInvoice failed: ${resp.status} ${text.slice(0, 200)}`);
    }
    return (await resp.json()) as LndLookupInvoiceResponse;
  }
}
