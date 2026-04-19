// HTTP wallet driver compatible with LNbits-style APIs (also works with any
// service exposing POST /api/v1/payments { out, bolt11 } → 201 { payment_hash }
// and GET /api/v1/payments/<hash> → { paid, preimage, fee }).
//
// Shape overrides (payEndpoint / statusEndpoint / bodyFor / parsePay /
// parseStatus) let callers adapt to Alby Hub, LNDHub, BTCPay Lightning, or a
// custom proxy without rebuilding the polling loop. Defaults target LNbits
// because it's the dominant open-source LN HTTP wallet.
//
// Auth: `adminKey` ships as `X-Api-Key` by default — override `authHeader` for
// BTCPay ("Authorization: token <...>") or LNDHub (Basic auth).

import { WalletError } from '../errors';
import type { Wallet } from '../types';

export interface LnurlWalletOptions {
  /** Base URL, e.g. "https://legend.lnbits.com". No trailing slash required. */
  baseUrl: string;
  /** Wallet admin key (LNbits-compatible). Sent as X-Api-Key by default. */
  adminKey: string;
  /** Override header name for bespoke back-ends. Default "X-Api-Key". */
  authHeader?: string;
  /** Override header value prefix (e.g. "token " or "Bearer "). Default "". */
  authPrefix?: string;
  /** POST endpoint path. Default "/api/v1/payments". */
  payPath?: string;
  /** GET status path template — `{hash}` substitutes payment_hash.
   *  Default "/api/v1/payments/{hash}". */
  statusPath?: string;
  /** Request timeout per HTTP call (ms). Default 15_000. */
  timeout_ms?: number;
  /** Total time allotted to reach a paid state (ms). Default 60_000. */
  poll_timeout_ms?: number;
  /** Poll interval between status checks (ms). Default 1_000. */
  poll_interval_ms?: number;
  /** DI point for tests / TLS / custom agents. */
  fetch?: typeof fetch;
}

interface PayResponse {
  payment_hash: string;
  checking_id?: string;
}

interface StatusResponse {
  paid: boolean;
  preimage: string | null;
  fee?: number; // sats in some deployments; msats in others — normalise below
  fee_msat?: number;
  details?: { fee?: number; fee_msat?: number };
}

export class LnurlWallet implements Wallet {
  private readonly baseUrl: string;
  private readonly adminKey: string;
  private readonly authHeader: string;
  private readonly authPrefix: string;
  private readonly payPath: string;
  private readonly statusPath: string;
  private readonly timeout_ms: number;
  private readonly pollTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LnurlWalletOptions) {
    if (!opts.baseUrl) throw new Error('LnurlWallet: baseUrl required');
    if (!opts.adminKey) throw new Error('LnurlWallet: adminKey required');
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.adminKey = opts.adminKey;
    this.authHeader = opts.authHeader ?? 'X-Api-Key';
    this.authPrefix = opts.authPrefix ?? '';
    this.payPath = opts.payPath ?? '/api/v1/payments';
    this.statusPath = opts.statusPath ?? '/api/v1/payments/{hash}';
    this.timeout_ms = opts.timeout_ms ?? 15_000;
    this.pollTimeoutMs = opts.poll_timeout_ms ?? 60_000;
    this.pollIntervalMs = opts.poll_interval_ms ?? 1_000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error('LnurlWallet: no fetch available — pass opts.fetch');
    }
  }

  async payInvoice(
    bolt11: string,
    maxFeeSats: number,
  ): Promise<{ preimage: string; feePaidSats: number }> {
    const pay = await this.postPay(bolt11);
    const result = await this.pollUntilPaid(pay.payment_hash);
    const feeSats = normalizeFeeSats(result);
    if (feeSats > maxFeeSats) {
      // Post-paid fee breach — money's already on the wire. Surface the
      // overage to the agent via WalletError so they don't silently accept.
      throw new WalletError(
        `Wallet paid ${feeSats} sats in fees, exceeding cap ${maxFeeSats}`,
        'FEE_LIMIT_EXCEEDED',
      );
    }
    if (!result.preimage) {
      throw new WalletError(
        'Wallet reported paid=true but no preimage',
        'INVALID_RESPONSE',
      );
    }
    return { preimage: result.preimage, feePaidSats: feeSats };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.withTimeout(
        this.fetchImpl(`${this.baseUrl}/api/v1/wallet`, {
          method: 'GET',
          headers: this.authHeaders(),
        }),
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  private async postPay(bolt11: string): Promise<PayResponse> {
    let res: Response;
    try {
      res = await this.withTimeout(
        this.fetchImpl(`${this.baseUrl}${this.payPath}`, {
          method: 'POST',
          headers: {
            ...this.authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ out: true, bolt11 }),
        }),
      );
    } catch (err) {
      if (err instanceof WalletError) throw err;
      throw new WalletError(
        `HTTP wallet transport error: ${err instanceof Error ? err.message : String(err)}`,
        'TRANSPORT',
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new WalletError(
        `HTTP wallet ${res.status}: ${text.slice(0, 200) || '(empty)'}`,
        mapHttpToCode(res.status),
      );
    }
    const body = (await res.json().catch(() => null)) as PayResponse | null;
    if (!body || !body.payment_hash) {
      throw new WalletError(
        'HTTP wallet: response missing payment_hash',
        'INVALID_RESPONSE',
      );
    }
    return body;
  }

  private async pollUntilPaid(paymentHash: string): Promise<StatusResponse> {
    const deadline = Date.now() + this.pollTimeoutMs;
    const url = `${this.baseUrl}${this.statusPath.replace('{hash}', paymentHash)}`;
    while (Date.now() < deadline) {
      let res: Response;
      try {
        res = await this.withTimeout(
          this.fetchImpl(url, {
            method: 'GET',
            headers: this.authHeaders(),
          }),
        );
      } catch (err) {
        if (err instanceof WalletError) throw err;
        throw new WalletError(
          `HTTP wallet transport error: ${err instanceof Error ? err.message : String(err)}`,
          'TRANSPORT',
        );
      }
      if (!res.ok) {
        throw new WalletError(
          `HTTP wallet status ${res.status}`,
          mapHttpToCode(res.status),
        );
      }
      const body = (await res.json().catch(() => null)) as StatusResponse | null;
      if (body && body.paid) return body;
      await sleep(this.pollIntervalMs);
    }
    throw new WalletError(
      `HTTP wallet payment not confirmed within ${this.pollTimeoutMs}ms`,
      'PAYMENT_TIMEOUT',
    );
  }

  private async withTimeout(p: Promise<Response>): Promise<Response> {
    // Best-effort guardrail. We don't manage AbortController at this layer
    // because LNbits/BTCPay tend to respond fast; the sleep()+deadline loop in
    // pollUntilPaid provides the outer bound.
    return Promise.race([
      p,
      new Promise<Response>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new WalletError(
                `HTTP wallet request timed out after ${this.timeout_ms}ms`,
                'TIMEOUT',
              ),
            ),
          this.timeout_ms,
        ),
      ),
    ]);
  }

  private authHeaders(): Record<string, string> {
    return {
      [this.authHeader]: `${this.authPrefix}${this.adminKey}`,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeFeeSats(s: StatusResponse): number {
  // LNbits populates fee_msat; legacy deployments return fee (sats).
  // BTCPay nests under details.
  const msat =
    s.fee_msat ??
    s.details?.fee_msat ??
    (s.fee !== undefined ? s.fee * 1000 : undefined) ??
    (s.details?.fee !== undefined ? s.details.fee * 1000 : undefined);
  if (msat === undefined) return 0;
  return Math.floor(msat / 1000);
}

function mapHttpToCode(status: number): string {
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 400) return 'PAYMENT_FAILED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'WALLET_SERVER_ERROR';
  return 'WALLET_HTTP_ERROR';
}
