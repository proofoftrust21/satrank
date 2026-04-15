// HTTP client for the SatRank API — zero dependencies, native fetch()
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
  PaymentResult,
  TransactResult,
  BestRouteRequest,
  BestRouteResponse,
  DepositInvoiceResponse,
  DepositVerifyResponse,
  ServiceSearchParams,
  ServiceResult,
  ServiceCategory,
  WalletProvider,
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
  /** Remaining L402 balance (updated from X-SatRank-Balance header). null if unknown. */
  lastBalance: number | null = null;

  constructor(baseUrl: string, options: SatRankClientOptions = {}) {
    // Remove trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeout = options.timeout ?? 10000;
    this.headers = options.headers ?? {};
  }

  /** Returns the remaining L402 token balance, or null if not yet known. */
  getBalance(): number | null {
    return this.lastBalance;
  }

  /** Detailed agent score */
  async getScore(publicKeyHash: string): Promise<AgentScoreResponse> {
    const envelope = await this.get<ApiEnvelope<AgentScoreResponse>>(`/api/agent/${publicKeyHash}`);
    return envelope.data;
  }

  /** Top agents leaderboard */
  async getTopAgents(limit = 20, offset = 0): Promise<TopAgentsResponse> {
    const envelope = await this.get<ApiEnvelope<TopAgentsResponse['agents']>>(`/api/agents/top?limit=${limit}&offset=${offset}`);
    return { agents: envelope.data, meta: envelope.meta! };
  }

  /** Search agents by alias */
  async searchAgents(alias: string, limit = 20, offset = 0): Promise<SearchAgentsResponse> {
    const envelope = await this.get<ApiEnvelope<SearchAgentsResponse['agents']>>(`/api/agents/search?alias=${encodeURIComponent(alias)}&limit=${limit}&offset=${offset}`);
    return { agents: envelope.data, meta: envelope.meta! };
  }

  /** Agent score history */
  async getHistory(publicKeyHash: string, limit = 20, offset = 0): Promise<HistoryResponse> {
    const envelope = await this.get<ApiEnvelope<HistoryResponse['snapshots']>>(`/api/agent/${publicKeyHash}/history?limit=${limit}&offset=${offset}`);
    return { snapshots: envelope.data, meta: envelope.meta! };
  }

  /** Attestations received by an agent */
  async getAttestations(publicKeyHash: string, limit = 20, offset = 0): Promise<AttestationsResponse> {
    const envelope = await this.get<ApiEnvelope<AttestationsResponse['attestations']>>(`/api/agent/${publicKeyHash}/attestations?limit=${limit}&offset=${offset}`);
    return { attestations: envelope.data, meta: envelope.meta! };
  }

  /** Global network statistics */
  async getStats(): Promise<NetworkStats> {
    const envelope = await this.get<ApiEnvelope<NetworkStats>>(`/api/stats`);
    return envelope.data;
  }

  /** Service health status */
  async getHealth(): Promise<HealthResponse> {
    const envelope = await this.get<ApiEnvelope<HealthResponse>>(`/api/health`);
    return envelope.data;
  }

  /** Service version */
  async getVersion(): Promise<VersionResponse> {
    const envelope = await this.get<ApiEnvelope<VersionResponse>>(`/api/version`);
    return envelope.data;
  }

  /** Agent verdict (SAFE / RISKY / UNKNOWN) */
  async getVerdict(publicKeyHash: string, callerPubkey?: string): Promise<VerdictResponse> {
    const qs = callerPubkey ? `?caller_pubkey=${callerPubkey}` : '';
    const envelope = await this.get<ApiEnvelope<VerdictResponse>>(`/api/agent/${publicKeyHash}/verdict${qs}`);
    return envelope.data;
  }

  /** Batch verdicts — up to 100 hashes in one request */
  async getBatchVerdicts(hashes: string[]): Promise<BatchVerdictItem[]> {
    const envelope = await this.post<ApiEnvelope<BatchVerdictItem[]>>(`/api/verdicts`, { hashes });
    return envelope.data;
  }

  /** Top movers — agents with biggest score changes in 7 days */
  async getMovers(): Promise<MoversResponse> {
    const envelope = await this.get<ApiEnvelope<MoversResponse>>(`/api/agents/movers`);
    return envelope.data;
  }

  /** Submit an attestation (requires API key in headers) */
  async submitAttestation(input: CreateAttestationInput): Promise<CreateAttestationResponse> {
    const envelope = await this.post<ApiEnvelope<CreateAttestationResponse>>(`/api/attestations`, input);
    return envelope.data;
  }

  // --- Decision endpoints ---

  /** GO / NO-GO decision with success probability */
  async decide(input: DecideRequest): Promise<DecideResponse> {
    const envelope = await this.post<ApiEnvelope<DecideResponse>>(`/api/decide`, input);
    return envelope.data;
  }

  /** Submit outcome report (success / failure / timeout) */
  async report(input: ReportRequest): Promise<ReportResponse> {
    const envelope = await this.post<ApiEnvelope<ReportResponse>>(`/api/report`, input);
    return envelope.data;
  }

  /** Batch pathfinding for up to 50 targets, returns top 3 by composite rank */
  async bestRoute(input: BestRouteRequest): Promise<BestRouteResponse> {
    const envelope = await this.post<ApiEnvelope<BestRouteResponse>>(`/api/best-route`, input);
    return envelope.data;
  }

  /** Restructured agent profile with reports, probe uptime, rank */
  async getProfile(id: string): Promise<ProfileResponse> {
    const envelope = await this.get<ApiEnvelope<ProfileResponse>>(`/api/profile/${id}`);
    return envelope.data;
  }

  // --- Service discovery (free) ---

  /** Search L402 services by keyword, category, score, or uptime. Free endpoint. */
  async searchServices(params: ServiceSearchParams = {}): Promise<{ data: ServiceResult[]; meta: PaginationMeta }> {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.category) qs.set('category', params.category);
    if (params.minScore !== undefined) qs.set('minScore', String(params.minScore));
    if (params.minUptime !== undefined) qs.set('minUptime', String(params.minUptime));
    if (params.sort) qs.set('sort', params.sort);
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    if (params.offset !== undefined) qs.set('offset', String(params.offset));
    const query = qs.toString();
    return this.get<{ data: ServiceResult[]; meta: PaginationMeta }>(`/api/services${query ? `?${query}` : ''}`);
  }

  /** List available service categories with counts. Free endpoint. */
  async getCategories(): Promise<ServiceCategory[]> {
    const envelope = await this.get<{ data: ServiceCategory[] }>(`/api/services/categories`);
    return envelope.data;
  }

  // --- Deposit (free endpoint, generates Lightning invoice) ---

  /**
   * Request a deposit invoice for bulk L402 balance (21–10,000 sats, 1 sat = 1 request).
   *
   * This is phase 1 of a two-step process:
   * 1. Call `deposit(amount)` → receive a BOLT11 Lightning invoice
   * 2. Pay the invoice with your Lightning wallet (out-of-band)
   * 3. Call `verifyDeposit(paymentHash, preimage)` → receive your token
   * 4. Use the token on all paid endpoints: `Authorization: L402 deposit:<preimage>`
   *
   * The deposit token replaces the standard L402 token for all paid endpoints.
   * Both token types work interchangeably.
   */
  async deposit(amount: number): Promise<DepositInvoiceResponse> {
    return this.post<DepositInvoiceResponse>(`/api/deposit`, { amount });
  }

  /**
   * Verify a deposit payment and activate the balance (phase 2).
   *
   * Call this after paying the invoice from `deposit()`. The preimage proves
   * payment and becomes your auth token: `Authorization: L402 deposit:<preimage>`.
   *
   * @param paymentHash - The paymentHash returned by deposit() phase 1
   * @param preimage - The preimage from your Lightning wallet after payment
   * @returns The token string and balance. Set headers.Authorization to the token value.
   */
  async verifyDeposit(paymentHash: string, preimage: string): Promise<DepositVerifyResponse> {
    return this.post<DepositVerifyResponse>(`/api/deposit`, { paymentHash, preimage });
  }

  // --- Transact (decide → pay → report) ---

  /**
   * Decide → Pay → Report in one call. The full cycle.
   *
   * @param target - Target agent hash or Lightning pubkey
   * @param caller - Your agent hash or Lightning pubkey
   * @param payFn - Your payment function. Called only if decide returns go=true.
   *                Must return { success, preimage?, paymentHash? }.
   *                Provide preimage + paymentHash for 2x weight bonus on the report.
   * @param options - Optional: walletProvider, amountSats, serviceUrl for positional pathfinding and health check
   * @returns { paid, decision, report? }
   */
  async transact(
    target: string,
    caller: string,
    payFn: () => Promise<PaymentResult>,
    options?: { walletProvider?: WalletProvider; amountSats?: number; serviceUrl?: string; callerNodePubkey?: string },
  ): Promise<TransactResult> {
    const decision = await this.decide({
      target,
      caller,
      walletProvider: options?.walletProvider,
      amountSats: options?.amountSats,
      serviceUrl: options?.serviceUrl,
      callerNodePubkey: options?.callerNodePubkey,
    });

    if (!decision.go) {
      return { paid: false, decision };
    }

    const payment = await payFn();

    const report = await this.report({
      target,
      reporter: caller,
      outcome: payment.success ? 'success' : 'failure',
      preimage: payment.preimage,
      paymentHash: payment.paymentHash,
    });

    return { paid: payment.success, decision, report };
  }

  // --- Monitoring ---

  /** Poll GET /api/watchlist for verdict changes. Free endpoint.
   *  Returns only targets whose score changed since `since`. */
  async getWatchlist(targets: string[], since?: number): Promise<WatchlistResponse> {
    const qs = `targets=${targets.join(',')}`  + (since != null ? `&since=${since}` : '');
    return this.get<WatchlistResponse>(`/api/watchlist?${qs}`);
  }

  /**
   * Poll /api/watchlist on an interval. Calls `onChanges` only when scores change.
   * Returns an unsubscribe function to stop polling.
   *
   * This is the HTTP fallback. For real-time updates, use Nostr NIP-85 subscriptions
   * (see watchNostr() or the README for the Nostr REQ pattern).
   */
  watchPoll(
    targets: string[],
    options: { intervalMs?: number },
    onChanges: (changes: WatchlistChange[]) => void,
  ): () => void {
    let since = Math.floor(Date.now() / 1000);
    let stopped = false;

    const poll = async () => {
      if (stopped) return;
      try {
        const result = await this.getWatchlist(targets, since);
        if (result.data.length > 0) {
          onChanges(result.data);
        }
        since = result.meta.queriedAt;
      } catch { /* swallow — retry next cycle */ }
      if (!stopped) timer = setTimeout(poll, options.intervalMs ?? 300_000);
    };

    let timer: ReturnType<typeof setTimeout> = setTimeout(poll, 0);
    return () => { stopped = true; clearTimeout(timer); };
  }

  /**
   * Subscribe to NIP-85 kind 30382 score changes via Nostr relays.
   * Requires a WebSocket-capable runtime (Node 22+, browsers, Deno, Bun).
   *
   * This is the recommended real-time monitoring method. SatRank publishes
   * delta-only events every 30 minutes to 3 public relays.
   *
   * @param targets Lightning pubkeys (02/03 prefix, 66 chars) to watch
   * @param onEvent Called for each score change event with parsed tags
   * @param relays Override default relays (default: relay.damus.io, nos.lol, relay.primal.net)
   * @returns Unsubscribe function that closes all relay connections
   */
  watchNostr(
    targets: string[],
    onEvent: (event: NostrScoreEvent) => void,
    relays: string[] = SATRANK_RELAYS,
  ): () => void {
    const sockets: WebSocket[] = [];
    const subId = `satrank-${Date.now().toString(36)}`;

    const filter = {
      kinds: [30382],
      authors: [SATRANK_NOSTR_PUBKEY],
      '#d': targets,
    };

    for (const relay of relays) {
      try {
        const ws = new WebSocket(relay);
        sockets.push(ws);

        ws.onopen = () => {
          ws.send(JSON.stringify(['REQ', subId, filter]));
        };

        ws.onmessage = (msg) => {
          try {
            const data = JSON.parse(typeof msg.data === 'string' ? msg.data : msg.data.toString());
            if (data[0] === 'EVENT' && data[1] === subId && data[2]) {
              const event = parseNostrScoreEvent(data[2]);
              if (event) onEvent(event);
            }
          } catch { /* malformed event — skip */ }
        };

        ws.onerror = () => { /* relay down — others continue */ };
      } catch { /* WebSocket not available or relay unreachable */ }
    }

    return () => {
      for (const ws of sockets) {
        try {
          ws.send(JSON.stringify(['CLOSE', subId]));
          ws.close();
        } catch { /* already closed */ }
      }
    };
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

      // Track remaining balance from response header
      const balanceHeader = response.headers.get('x-satrank-balance');
      if (balanceHeader !== null) this.lastBalance = parseInt(balanceHeader, 10);

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

      // Track remaining balance from response header
      const balanceHeader = response.headers.get('x-satrank-balance');
      if (balanceHeader !== null) this.lastBalance = parseInt(balanceHeader, 10);

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

// --- Nostr constants and helpers ---

const SATRANK_NOSTR_PUBKEY = '5d11d46de1ba4d3295a33658df12eebb5384d6d6679f05b65fec3c86707de7d4';
const SATRANK_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

export interface NostrScoreEvent {
  pubkey: string;
  lnPubkey: string;
  alias: string | null;
  score: number | null;
  verdict: string | null;
  reachable: boolean | null;
  components: Record<string, number> | null;
  createdAt: number;
}

export interface WatchlistChange {
  publicKeyHash: string;
  alias: string | null;
  score: number;
  previousScore: number | null;
  verdict: 'SAFE' | 'RISKY' | 'UNKNOWN';
  components: Record<string, number> | null;
  changedAt: number;
}

export interface WatchlistResponse {
  data: WatchlistChange[];
  meta: { since: number; queriedAt: number; targets: number; changed: number };
}

function parseNostrScoreEvent(event: { pubkey: string; tags: string[][]; created_at: number }): NostrScoreEvent | null {
  const tags = new Map(event.tags.map(t => [t[0], t[1]]));
  const lnPubkey = tags.get('d');
  if (!lnPubkey) return null;
  const scoreStr = tags.get('rank');
  return {
    pubkey: event.pubkey,
    lnPubkey,
    alias: tags.get('alias') ?? null,
    score: scoreStr ? parseInt(scoreStr, 10) : null,
    verdict: tags.get('verdict') ?? null,
    reachable: tags.get('reachable') === 'true' ? true : tags.get('reachable') === 'false' ? false : null,
    components: parseComponents(tags),
    createdAt: event.created_at,
  };
}

function parseComponents(tags: Map<string, string>): Record<string, number> | null {
  const keys = ['volume', 'reputation', 'seniority', 'regularity', 'diversity'];
  const result: Record<string, number> = {};
  let found = false;
  for (const k of keys) {
    const v = tags.get(k);
    if (v) { result[k] = parseInt(v, 10); found = true; }
  }
  return found ? result : null;
}
