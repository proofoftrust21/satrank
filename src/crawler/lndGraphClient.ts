// HTTP client for LND REST API — primary Lightning graph source
// Reads the full graph from our Voltage LND node
import fs from 'fs';
import { logger } from '../logger';
import { CircuitBreaker } from '../utils/circuitBreaker';

export interface LndNode {
  pub_key: string;
  alias: string;
  color: string;
  addresses: Array<{ network: string; addr: string }>;
  last_update: number;
}

export interface LndRoutingPolicy {
  fee_base_msat: string;
  fee_rate_milli_msat: string;
  disabled: boolean;
  min_htlc: string;
  max_htlc_msat: string;
  time_lock_delta: number;
  last_update: number;
}

export interface LndEdge {
  channel_id: string;
  chan_point: string;
  capacity: string; // LND returns capacity as string
  node1_pub: string;
  node2_pub: string;
  node1_policy: LndRoutingPolicy | null;
  node2_policy: LndRoutingPolicy | null;
}

export interface LndGraph {
  nodes: LndNode[];
  edges: LndEdge[];
}

export interface LndNodeInfo {
  node: LndNode;
  num_channels: number;
  total_capacity: string;
}

export interface LndGetInfoResponse {
  synced_to_graph: boolean;
  identity_pubkey: string;
  alias: string;
  num_active_channels: number;
  num_peers: number;
  block_height: number;
}

export interface LndQueryRoutesResponse {
  routes: Array<{
    total_time_lock: number;
    total_fees: string;
    total_fees_msat: string;
    total_amt: string;
    total_amt_msat: string;
    hops: Array<{
      chan_id: string;
      chan_capacity: string;
      amt_to_forward: string;
      fee: string;
      fee_msat: string;
      pub_key: string;
    }>;
  }>;
}

export interface LndGraphClient {
  getInfo(): Promise<LndGetInfoResponse>;
  getGraph(): Promise<LndGraph>;
  getNodeInfo(pubkey: string): Promise<LndNodeInfo | null>;
  queryRoutes(pubkey: string, amountSats: number, sourcePubKey?: string): Promise<LndQueryRoutesResponse>;
  decodePayReq?(payReq: string): Promise<{ destination: string } | null>;
  payInvoice?(paymentRequest: string, feeLimitSat?: number): Promise<{ paymentPreimage: string; paymentHash: string; paymentError?: string }>;
}

export interface LndClientOptions {
  restUrl: string;
  macaroonPath: string;
  timeoutMs: number;
}

export class HttpLndGraphClient implements LndGraphClient {
  private restUrl: string;
  private macaroonHex: string;
  private timeoutMs: number;
  private breaker: CircuitBreaker;

  constructor(options: LndClientOptions) {
    this.restUrl = options.restUrl.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs;
    this.breaker = new CircuitBreaker({ name: 'lnd' });

    try {
      const macaroonBytes = fs.readFileSync(options.macaroonPath);
      this.macaroonHex = macaroonBytes.toString('hex');
      logger.debug({
        url: this.restUrl,
        macaroonLen: this.macaroonHex.length,
      }, 'LND client initialized');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ path: options.macaroonPath, error: msg }, 'Failed to read LND macaroon — LND client will not work');
      this.macaroonHex = '';
    }
  }

  isConfigured(): boolean {
    return this.macaroonHex.length > 0;
  }

  async getInfo(): Promise<LndGetInfoResponse> {
    return this.request<LndGetInfoResponse>('/v1/getinfo');
  }

  async getGraph(): Promise<LndGraph> {
    return this.request<LndGraph>('/v1/graph');
  }

  async queryRoutes(pubkey: string, amountSats: number, sourcePubKey?: string): Promise<LndQueryRoutesResponse> {
    if (!/^(02|03)[a-f0-9]{64}$/.test(pubkey)) {
      throw new Error(`Invalid Lightning pubkey format: ${pubkey.slice(0, 16)}`);
    }
    if (sourcePubKey && !/^(02|03)[a-f0-9]{64}$/.test(sourcePubKey)) {
      throw new Error(`Invalid source pubkey format: ${sourcePubKey.slice(0, 16)}`);
    }
    const sanitizedAmount = Math.floor(amountSats);
    if (sanitizedAmount <= 0 || sanitizedAmount > 10_000_000) {
      throw new Error(`Invalid amountSats: ${amountSats}`);
    }
    try {
      const path = sourcePubKey
        ? `/v1/graph/routes/${pubkey}/${sanitizedAmount}?source_pub_key=${sourcePubKey}`
        : `/v1/graph/routes/${pubkey}/${sanitizedAmount}`;
      return await this.request<LndQueryRoutesResponse>(path);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('unable to find a path') || msg.includes('FAILURE_REASON')) {
        // "No route" is a valid LND response, not a connection failure.
        // request() already called breaker.onFailure() for the HTTP 404 —
        // compensate with onSuccess() so the breaker stays closed.
        this.breaker.onSuccess();
        return { routes: [] };
      }
      throw err;
    }
  }

  async getNodeInfo(pubkey: string): Promise<LndNodeInfo | null> {
    if (!/^(02|03)[a-f0-9]{64}$/.test(pubkey)) {
      throw new Error(`Invalid Lightning pubkey format: ${pubkey.slice(0, 16)}`);
    }
    try {
      return await this.request<LndNodeInfo>(`/v1/graph/node/${pubkey}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('404') || msg.includes('unable to find')) {
        return null;
      }
      throw err;
    }
  }

  async decodePayReq(payReq: string): Promise<{ destination: string; num_satoshis?: string } | null> {
    try {
      const data = await this.request<{ destination: string; num_satoshis?: string }>(`/v1/payreq/${payReq}`);
      return data?.destination ? { destination: data.destination, num_satoshis: data.num_satoshis } : null;
    } catch {
      return null;
    }
  }

  async payInvoice(paymentRequest: string, feeLimitSat: number = 10): Promise<{ paymentPreimage: string; paymentHash: string; paymentError?: string }> {
    if (!this.macaroonHex) throw new Error('LND macaroon not loaded');
    const url = `${this.restUrl}/v1/channels/transactions`;
    const body = JSON.stringify({ payment_request: paymentRequest, fee_limit: { fixed: String(feeLimitSat) } });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000); // 60s for payment settlement
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Grpc-Metadata-macaroon': this.macaroonHex, 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await response.json() as Record<string, string>;
      if (data.payment_error) {
        return { paymentPreimage: '', paymentHash: '', paymentError: data.payment_error };
      }
      return { paymentPreimage: data.payment_preimage ?? '', paymentHash: data.payment_hash ?? '' };
    } catch (err: unknown) {
      clearTimeout(timeout);
      const msg = err instanceof Error ? err.message : String(err);
      return { paymentPreimage: '', paymentHash: '', paymentError: msg };
    }
  }

  private async request<T>(path: string): Promise<T> {
    if (!this.macaroonHex) {
      throw new Error('LND macaroon not loaded — cannot make requests');
    }

    if (!this.breaker.canExecute()) {
      throw new Error(`LND circuit breaker open — skipping request: ${path}`);
    }

    const url = `${this.restUrl}${path}`;
    logger.debug({ url, timeoutMs: this.timeoutMs }, 'LND request starting');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Grpc-Metadata-macaroon': this.macaroonHex,
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        this.breaker.onFailure();
        throw new Error(`HTTP ${response.status}: ${response.statusText} — ${body.slice(0, 200)}`);
      }

      const result = await response.json() as T;
      this.breaker.onSuccess();
      return result;
    } catch (err: unknown) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === 'AbortError') {
        this.breaker.onFailure();
        throw new Error(`LND request timed out after ${this.timeoutMs}ms: ${path}`);
      }
      // Only call onFailure if we haven't already (non-ok response path)
      if (!(err instanceof Error && err.message.startsWith('HTTP '))) {
        this.breaker.onFailure();
      }
      throw err;
    }
  }
}
