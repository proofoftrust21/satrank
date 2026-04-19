// LND REST driver — pays BOLT11 via POST /v1/channels/transactions.
//
// TLS with self-signed certs: LND ships with a self-signed cert by default.
// The SDK stays dependency-free by delegating TLS to the user's fetch: pass
// a custom fetch built with `undici.Agent({ connect: { rejectUnauthorized: false }})`
// for local dev, or a proper CA-signed cert in production.
//
// Auth: the admin.macaroon hex goes in the `Grpc-Metadata-macaroon` header.
// Prefer a more narrowly-scoped macaroon (invoice.macaroon / routing.macaroon)
// when paying on behalf of an untrusted agent.

import { WalletError } from '../errors';
import type { Wallet } from '../types';

export interface LndWalletOptions {
  /** Full base URL, e.g. "https://localhost:8080" (no trailing slash required). */
  restEndpoint: string;
  /** Admin or send-scope macaroon encoded as hex (see `xxd -ps -u -c 1000 admin.macaroon`). */
  macaroonHex: string;
  /** DI point — swap for a custom fetch (e.g. undici Agent) to handle self-signed TLS. */
  fetch?: typeof fetch;
  /** Request timeout for the payment call (ms). Default 60_000 — payments can
   *  take a while if LND probes multiple routes. */
  timeout_ms?: number;
}

interface LndSendPaymentRequest {
  payment_request: string;
  fee_limit?: { fixed: string };
  timeout_seconds?: number;
  allow_self_payment?: boolean;
}

interface LndSendPaymentResponse {
  payment_error?: string;
  payment_preimage?: string; // base64
  payment_hash?: string; // base64
  payment_route?: {
    total_fees?: string;
    total_fees_msat?: string;
    total_amt?: string;
  };
}

function base64ToHex(b64: string): string {
  return Buffer.from(b64, 'base64').toString('hex');
}

export class LndWallet implements Wallet {
  private readonly restEndpoint: string;
  private readonly macaroonHex: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeout_ms: number;

  constructor(opts: LndWalletOptions) {
    if (!opts.restEndpoint) throw new Error('LndWallet: restEndpoint required');
    if (!opts.macaroonHex) throw new Error('LndWallet: macaroonHex required');
    if (!/^[a-f0-9]+$/i.test(opts.macaroonHex)) {
      throw new Error('LndWallet: macaroonHex must be lowercase hex');
    }
    this.restEndpoint = opts.restEndpoint.replace(/\/$/, '');
    this.macaroonHex = opts.macaroonHex.toLowerCase();
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error('LndWallet: no fetch available — pass opts.fetch');
    }
    this.timeout_ms = opts.timeout_ms ?? 60_000;
  }

  async payInvoice(
    bolt11: string,
    maxFeeSats: number,
  ): Promise<{ preimage: string; feePaidSats: number }> {
    const body: LndSendPaymentRequest = {
      payment_request: bolt11,
      // LND 0.13+: `fee_limit.fixed` is in sats (as a stringified int).
      fee_limit: { fixed: String(Math.max(0, Math.floor(maxFeeSats))) },
      // Internal wall clock for the pay RPC. Slightly under our fetch timeout
      // so LND has a chance to return a structured error rather than us aborting.
      timeout_seconds: Math.max(
        10,
        Math.floor((this.timeout_ms - 2_000) / 1_000),
      ),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout_ms);

    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.restEndpoint}/v1/channels/transactions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Grpc-Metadata-macaroon': this.macaroonHex,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new WalletError('LND pay request timed out', 'TIMEOUT');
      }
      throw new WalletError(
        `LND transport error: ${err instanceof Error ? err.message : String(err)}`,
        'TRANSPORT',
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new WalletError(
        `LND HTTP ${res.status}: ${text.slice(0, 200) || '(empty)'}`,
        mapHttpToWalletCode(res.status),
      );
    }

    const payload = (await res.json().catch(() => null)) as
      | LndSendPaymentResponse
      | null;
    if (!payload) {
      throw new WalletError('LND returned non-JSON body', 'INVALID_RESPONSE');
    }

    if (payload.payment_error && payload.payment_error.length > 0) {
      throw new WalletError(
        `LND payment failed: ${payload.payment_error}`,
        mapPaymentErrorCode(payload.payment_error),
      );
    }

    if (!payload.payment_preimage || payload.payment_preimage.length === 0) {
      throw new WalletError(
        'LND returned empty preimage with no error',
        'INVALID_RESPONSE',
      );
    }

    const preimage = base64ToHex(payload.payment_preimage);
    const feeSats = parseInt(payload.payment_route?.total_fees ?? '0', 10);
    return {
      preimage,
      feePaidSats: Number.isFinite(feeSats) ? feeSats : 0,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.restEndpoint}/v1/getinfo`, {
        method: 'GET',
        headers: { 'Grpc-Metadata-macaroon': this.macaroonHex },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

function mapHttpToWalletCode(status: number): string {
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status === 404) return 'NOT_FOUND';
  if (status >= 500) return 'LND_SERVER_ERROR';
  return 'LND_HTTP_ERROR';
}

function mapPaymentErrorCode(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes('insufficient')) return 'INSUFFICIENT_BALANCE';
  if (lower.includes('no route') || lower.includes('no_route')) return 'NO_ROUTE';
  if (lower.includes('timeout') || lower.includes('timed out')) return 'PAYMENT_TIMEOUT';
  if (lower.includes('fee') && lower.includes('exceed')) return 'FEE_LIMIT_EXCEEDED';
  if (lower.includes('already paid') || lower.includes('already_paid'))
    return 'ALREADY_PAID';
  return 'PAYMENT_FAILED';
}
