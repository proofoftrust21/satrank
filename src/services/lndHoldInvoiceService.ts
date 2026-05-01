// Phase 6 (2026-05-01) — LND hold-invoice helpers.
//
// Wraps LND's invoicesrpc surface (/v2/invoices/hodl, /v2/invoices/settle,
// /v2/invoices/cancel, /v2/invoices/lookup) used by the non-custodial
// fulfill mode. Caller must hold the *admin* macaroon — invoicesrpc.write
// is not granted to the read-only invoice macaroon used by /api/deposit.
//
// State semantics (LND):
//   OPEN       — invoice broadcast, awaiting payment from agent
//   ACCEPTED   — HTLC arrived, sats locked in escrow until we settle/cancel
//   SETTLED    — we revealed the preimage; agent's funds claimed
//   CANCELED   — we cancelled; agent's HTLC unblocks, refund automatic
//   EXPIRED    — invoice timeout passed without settle (rare; handled like cancel)
//
// SatRank generates the preimage (32 random bytes) and only stores the
// SHA-256 hash on LND. The preimage stays on SatRank until either we
// settle (reveal it) or cancel (delete it).
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'fs';
import { logger } from '../logger';

export interface LndHoldInvoiceServiceOptions {
  restUrl: string;
  /** Path to the admin macaroon file. invoicesrpc.write is required —
   *  the standard "invoice-only" macaroon will return 401. */
  adminMacaroonPath?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface AddHoldInvoiceInput {
  /** sat amount the agent will pay; must include premium estimate. */
  valueSat: number;
  /** Free-form memo, surfaced in the agent's wallet when paying. */
  memo: string;
  /** Hold timeout in seconds before LND auto-expires the invoice (we still
   *  cancel proactively from the cron sooner). */
  expirySec: number;
}

export interface AddHoldInvoiceResult {
  /** BOLT11 the agent pays. */
  payment_request: string;
  /** SHA-256 of the preimage, hex (64 chars). Used to look up / settle / cancel. */
  payment_hash: string;
  /** The preimage SatRank generated. Stored ONLY in fulfill_jobs (DB);
   *  never logged or returned to the agent before settlement. */
  preimage: string;
}

/** LND v2 invoice state. The wire enum is uppercase; we expose the same
 *  string for log clarity. */
export type LndInvoiceState = 'OPEN' | 'ACCEPTED' | 'SETTLED' | 'CANCELED' | 'EXPIRED' | 'UNKNOWN';

export interface LndV2InvoiceLookup {
  state: LndInvoiceState;
  amt_paid_sat: number;
}

export class LndHoldInvoiceService {
  private readonly restUrl: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;
  private adminMacaroonHex: string | null = null;

  constructor(opts: LndHoldInvoiceServiceOptions) {
    this.restUrl = opts.restUrl;
    this.fetchImpl = opts.fetchImpl;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    if (opts.adminMacaroonPath) {
      try {
        this.adminMacaroonHex = readFileSync(opts.adminMacaroonPath).toString('hex');
        logger.info({ path: opts.adminMacaroonPath }, 'Hold-invoice admin macaroon loaded');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ error: msg }, 'Failed to load hold-invoice admin macaroon — hold mode disabled');
      }
    }
  }

  isAvailable(): boolean {
    return this.adminMacaroonHex !== null;
  }

  private doFetch(url: string, init: RequestInit): Promise<Response> {
    const f = this.fetchImpl ?? globalThis.fetch;
    return f(url, init);
  }

  /** Generate preimage + hash, register the hold invoice on LND, return the
   *  BOLT11 + hex payment_hash + the preimage SatRank must keep secret. */
  async addHoldInvoice(input: AddHoldInvoiceInput): Promise<AddHoldInvoiceResult> {
    if (!this.adminMacaroonHex) {
      throw new Error('LND admin macaroon not loaded — addHoldInvoice unavailable');
    }
    const preimage = randomBytes(32);
    const hash = createHash('sha256').update(preimage).digest();
    const resp = await this.doFetch(`${this.restUrl}/v2/invoices/hodl`, {
      method: 'POST',
      headers: {
        'Grpc-Metadata-macaroon': this.adminMacaroonHex,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // LND v2 expects base64 for binary fields.
        hash: hash.toString('base64'),
        value: String(input.valueSat),
        memo: input.memo,
        expiry: String(input.expirySec),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`LND addHoldInvoice failed: ${resp.status} ${text.slice(0, 200)}`);
    }
    const body = (await resp.json()) as { payment_request?: string };
    if (!body.payment_request) {
      throw new Error('LND addHoldInvoice returned empty payment_request');
    }
    return {
      payment_request: body.payment_request,
      payment_hash: hash.toString('hex'),
      preimage: preimage.toString('hex'),
    };
  }

  /** Look up the current state of a hold invoice. Returns 'UNKNOWN' if the
   *  invoice is not found (e.g. concurrent cancel). Caller should treat
   *  UNKNOWN as terminal and stop polling. */
  async lookupState(paymentHashHex: string): Promise<LndV2InvoiceLookup> {
    if (!this.adminMacaroonHex) {
      throw new Error('LND admin macaroon not loaded — lookupState unavailable');
    }
    const resp = await this.doFetch(
      `${this.restUrl}/v1/invoice/${paymentHashHex}`,
      {
        headers: { 'Grpc-Metadata-macaroon': this.adminMacaroonHex },
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (resp.status === 404) {
      return { state: 'UNKNOWN', amt_paid_sat: 0 };
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`LND lookupInvoice failed: ${resp.status} ${text.slice(0, 200)}`);
    }
    const body = (await resp.json()) as { state?: string; amt_paid_sat?: string };
    const stateRaw = String(body.state ?? '').toUpperCase();
    const state: LndInvoiceState =
      stateRaw === 'OPEN' || stateRaw === 'ACCEPTED' || stateRaw === 'SETTLED'
        || stateRaw === 'CANCELED' || stateRaw === 'EXPIRED'
        ? stateRaw
        : 'UNKNOWN';
    return {
      state,
      amt_paid_sat: Number(body.amt_paid_sat ?? 0),
    };
  }

  /** Settle a hold invoice — reveal the preimage, claim the agent's HTLC.
   *  Idempotent: settling an already-settled invoice returns success. */
  async settle(preimageHex: string): Promise<void> {
    if (!this.adminMacaroonHex) {
      throw new Error('LND admin macaroon not loaded — settleInvoice unavailable');
    }
    const preimageB64 = Buffer.from(preimageHex, 'hex').toString('base64');
    const resp = await this.doFetch(`${this.restUrl}/v2/invoices/settle`, {
      method: 'POST',
      headers: {
        'Grpc-Metadata-macaroon': this.adminMacaroonHex,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ preimage: preimageB64 }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!resp.ok) {
      const text = await resp.text();
      // LND returns specific errors when the invoice is already settled —
      // bubble those as a logical no-op rather than throw.
      if (/already settled|invoice already canceled/i.test(text)) {
        logger.info({ preimage_hex_first8: preimageHex.slice(0, 8) }, 'settle: invoice already terminal');
        return;
      }
      throw new Error(`LND settleInvoice failed: ${resp.status} ${text.slice(0, 200)}`);
    }
  }

  /** Cancel a hold invoice — release the agent's HTLC, refund automatic. */
  async cancel(paymentHashHex: string): Promise<void> {
    if (!this.adminMacaroonHex) {
      throw new Error('LND admin macaroon not loaded — cancelInvoice unavailable');
    }
    const hashB64 = Buffer.from(paymentHashHex, 'hex').toString('base64');
    const resp = await this.doFetch(`${this.restUrl}/v2/invoices/cancel`, {
      method: 'POST',
      headers: {
        'Grpc-Metadata-macaroon': this.adminMacaroonHex,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ payment_hash: hashB64 }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!resp.ok) {
      const text = await resp.text();
      if (/already settled|invoice already canceled/i.test(text)) {
        logger.info({ hash_hex_first8: paymentHashHex.slice(0, 8) }, 'cancel: invoice already terminal');
        return;
      }
      throw new Error(`LND cancelInvoice failed: ${resp.status} ${text.slice(0, 200)}`);
    }
  }
}
