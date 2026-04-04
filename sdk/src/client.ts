// HTTP client for the SatRank API v1 — zero dependencies, native fetch()
import type {
  AgentScoreResponse,
  TopAgentsResponse,
  SearchAgentsResponse,
  HistoryResponse,
  AttestationsResponse,
  HealthResponse,
  NetworkStats,
  VersionResponse,
  PaginationMeta,
  VerdictResponse,
  BatchVerdictItem,
  CreateAttestationInput,
  CreateAttestationResponse,
  MoversResponse,
  DecideRequest,
  DecideResponse,
  ReportRequest,
  ReportResponse,
  ProfileResponse,
} from './types';

export class SatRankError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'SatRankError';
  }
}

export interface SatRankClientOptions {
  /** Timeout in milliseconds (default 10000) */
  timeout?: number;
  /** Custom headers added to every request */
  headers?: Record<string, string>;
}

interface ApiEnvelope<T> {
  data: T;
  meta?: PaginationMeta;
}

export class SatRankClient {
  private baseUrl: string;
  private timeout: number;
  private headers: Record<string, string>;

  constructor(baseUrl: string, options: SatRankClientOptions = {}) {
    // Remove trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeout = options.timeout ?? 10000;
    this.headers = options.headers ?? {};
  }

  /** Detailed agent score */
  async getScore(publicKeyHash: string): Promise<AgentScoreResponse> {
    const envelope = await this.get<ApiEnvelope<AgentScoreResponse>>(`/api/v1/agent/${publicKeyHash}`);
    return envelope.data;
  }

  /** Top agents leaderboard */
  async getTopAgents(limit = 20, offset = 0): Promise<TopAgentsResponse> {
    const envelope = await this.get<ApiEnvelope<TopAgentsResponse['agents']>>(`/api/v1/agents/top?limit=${limit}&offset=${offset}`);
    return { agents: envelope.data, meta: envelope.meta! };
  }

  /** Search agents by alias */
  async searchAgents(alias: string, limit = 20, offset = 0): Promise<SearchAgentsResponse> {
    const envelope = await this.get<ApiEnvelope<SearchAgentsResponse['agents']>>(`/api/v1/agents/search?alias=${encodeURIComponent(alias)}&limit=${limit}&offset=${offset}`);
    return { agents: envelope.data, meta: envelope.meta! };
  }

  /** Agent score history */
  async getHistory(publicKeyHash: string, limit = 20, offset = 0): Promise<HistoryResponse> {
    const envelope = await this.get<ApiEnvelope<HistoryResponse['snapshots']>>(`/api/v1/agent/${publicKeyHash}/history?limit=${limit}&offset=${offset}`);
    return { snapshots: envelope.data, meta: envelope.meta! };
  }

  /** Attestations received by an agent */
  async getAttestations(publicKeyHash: string, limit = 20, offset = 0): Promise<AttestationsResponse> {
    const envelope = await this.get<ApiEnvelope<AttestationsResponse['attestations']>>(`/api/v1/agent/${publicKeyHash}/attestations?limit=${limit}&offset=${offset}`);
    return { attestations: envelope.data, meta: envelope.meta! };
  }

  /** Global network statistics */
  async getStats(): Promise<NetworkStats> {
    const envelope = await this.get<ApiEnvelope<NetworkStats>>(`/api/v1/stats`);
    return envelope.data;
  }

  /** Service health status */
  async getHealth(): Promise<HealthResponse> {
    const envelope = await this.get<ApiEnvelope<HealthResponse>>(`/api/v1/health`);
    return envelope.data;
  }

  /** Service version */
  async getVersion(): Promise<VersionResponse> {
    const envelope = await this.get<ApiEnvelope<VersionResponse>>(`/api/v1/version`);
    return envelope.data;
  }

  /** Agent verdict (SAFE / RISKY / UNKNOWN) */
  async getVerdict(publicKeyHash: string, callerPubkey?: string): Promise<VerdictResponse> {
    const qs = callerPubkey ? `?caller_pubkey=${callerPubkey}` : '';
    const envelope = await this.get<ApiEnvelope<VerdictResponse>>(`/api/v1/agent/${publicKeyHash}/verdict${qs}`);
    return envelope.data;
  }

  /** Batch verdicts — up to 100 hashes in one request */
  async getBatchVerdicts(hashes: string[]): Promise<BatchVerdictItem[]> {
    const envelope = await this.post<ApiEnvelope<BatchVerdictItem[]>>(`/api/v1/verdicts`, { hashes });
    return envelope.data;
  }

  /** Top movers — agents with biggest score changes in 7 days */
  async getMovers(): Promise<MoversResponse> {
    const envelope = await this.get<ApiEnvelope<MoversResponse>>(`/api/v1/agents/movers`);
    return envelope.data;
  }

  /** Submit an attestation (requires API key in headers) */
  async submitAttestation(input: CreateAttestationInput): Promise<CreateAttestationResponse> {
    const envelope = await this.post<ApiEnvelope<CreateAttestationResponse>>(`/api/v1/attestations`, input);
    return envelope.data;
  }

  // --- v2 endpoints ---

  /** GO / NO-GO decision with success probability */
  async decide(input: DecideRequest): Promise<DecideResponse> {
    const envelope = await this.post<ApiEnvelope<DecideResponse>>(`/api/v2/decide`, input);
    return envelope.data;
  }

  /** Submit outcome report (success / failure / timeout) */
  async report(input: ReportRequest): Promise<ReportResponse> {
    const envelope = await this.post<ApiEnvelope<ReportResponse>>(`/api/v2/report`, input);
    return envelope.data;
  }

  /** Restructured agent profile with reports, probe uptime, rank */
  async getProfile(id: string): Promise<ProfileResponse> {
    const envelope = await this.get<ApiEnvelope<ProfileResponse>>(`/api/v2/profile/${id}`);
    return envelope.data;
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'SatRank-SDK/0.1',
          ...this.headers,
        },
        signal: controller.signal,
      });

      const body = await response.json() as T & { error?: { code: string; message: string } };

      if (!response.ok) {
        const errBody = body as { error?: { code: string; message: string } };
        throw new SatRankError(
          errBody.error?.message ?? `HTTP ${response.status}`,
          response.status,
          errBody.error?.code ?? 'UNKNOWN',
        );
      }

      return body;
    } catch (err) {
      if (err instanceof SatRankError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new SatRankError('Request timeout', 0, 'TIMEOUT');
      }
      throw new SatRankError(
        err instanceof Error ? err.message : String(err),
        0,
        'NETWORK_ERROR',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'SatRank-SDK/0.1',
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const responseBody = await response.json() as T & { error?: { code: string; message: string } };

      if (!response.ok) {
        const errBody = responseBody as { error?: { code: string; message: string } };
        throw new SatRankError(
          errBody.error?.message ?? `HTTP ${response.status}`,
          response.status,
          errBody.error?.code ?? 'UNKNOWN',
        );
      }

      return responseBody;
    } catch (err) {
      if (err instanceof SatRankError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new SatRankError('Request timeout', 0, 'TIMEOUT');
      }
      throw new SatRankError(
        err instanceof Error ? err.message : String(err),
        0,
        'NETWORK_ERROR',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
