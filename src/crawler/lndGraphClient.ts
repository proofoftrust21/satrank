// HTTP client for LND REST API — primary Lightning graph source
// Reads the full graph from our Voltage LND node
import fs from 'fs';
import { logger } from '../logger';

export interface LndNode {
  pub_key: string;
  alias: string;
  color: string;
  addresses: Array<{ network: string; addr: string }>;
  last_update: number;
}

export interface LndEdge {
  channel_id: string;
  chan_point: string;
  capacity: string; // LND returns capacity as string
  node1_pub: string;
  node2_pub: string;
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

export interface LndGraphClient {
  getInfo(): Promise<LndGetInfoResponse>;
  getGraph(): Promise<LndGraph>;
  getNodeInfo(pubkey: string): Promise<LndNodeInfo | null>;
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

  constructor(options: LndClientOptions) {
    this.restUrl = options.restUrl.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs;

    try {
      const macaroonBytes = fs.readFileSync(options.macaroonPath);
      this.macaroonHex = macaroonBytes.toString('hex');
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

  private async request<T>(path: string): Promise<T> {
    if (!this.macaroonHex) {
      throw new Error('LND macaroon not loaded — cannot make requests');
    }

    const url = `${this.restUrl}${path}`;
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
        throw new Error(`HTTP ${response.status}: ${response.statusText} — ${body.slice(0, 200)}`);
      }

      return await response.json() as T;
    } catch (err: unknown) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`LND request timed out after ${this.timeoutMs}ms: ${path}`);
      }
      throw err;
    }
  }
}
