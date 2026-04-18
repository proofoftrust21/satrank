// SatRank API response types — Phase 3 Bayesian (no legacy composite shape)
// Decoupled from server — do not import from ../src/

export type AgentSource = 'observer_protocol' | '4tress' | 'lightning_graph' | 'manual';
export type AmountBucket = 'micro' | 'small' | 'medium' | 'large';
export type PaymentProtocol = 'l402' | 'keysend' | 'bolt11';

export interface PaginationMeta {
  total: number;
  limit: number;
  offset: number;
}

// --- Bayesian scoring block ---
// Canonical shape shared across every public endpoint (verdict, decide,
// profile, best-route, service, endpoint). Replaces the pre-Phase-3
// composite 0-100 `score` + `components` shape outright.

export type Verdict = 'SAFE' | 'RISKY' | 'UNKNOWN' | 'INSUFFICIENT';
export type BayesianWindow = '24h' | '7d' | '30d';
export type BayesianSource = 'probe' | 'report' | 'paid';

export interface BayesianSourceBlock {
  p_success: number;
  ci95_low: number;
  ci95_high: number;
  n_obs: number;
  weight_total: number;
}

export interface BayesianConvergence {
  converged: boolean;
  sources_above_threshold: BayesianSource[];
  threshold: number;
}

export interface BayesianScoreBlock {
  p_success: number;
  ci95_low: number;
  ci95_high: number;
  n_obs: number;
  verdict: Verdict;
  window: BayesianWindow;
  sources: {
    probe:  BayesianSourceBlock | null;
    report: BayesianSourceBlock | null;
    paid:   BayesianSourceBlock | null;
  };
  convergence: BayesianConvergence;
}

// --- Evidence (unchanged — transactions, probes, lightning graph) ---

export interface TransactionSample {
  txId: string;
  protocol: PaymentProtocol;
  amountBucket: AmountBucket;
  verified: boolean;
  timestamp: number;
}

export interface LightningGraphEvidence {
  publicKey: string;
  channels: number;
  capacitySats: number;
  sourceUrl: string;
}

export interface ReputationEvidence {
  positiveRatings: number;
  negativeRatings: number;
  lnplusRank: number;
  hubnessRank: number;
  betweennessRank: number;
  sourceUrl: string;
}

export interface PopularityEvidence {
  queryCount: number;
  bonusApplied: number;
}

export interface ProbeData {
  reachable: boolean;
  latencyMs: number | null;
  hops: number | null;
  estimatedFeeMsat: number | null;
  failureReason: string | null;
  probedAt: number;
}

export interface ScoreEvidence {
  transactions: {
    count: number;
    verifiedCount: number;
    sample: TransactionSample[];
  };
  lightningGraph: LightningGraphEvidence | null;
  reputation: ReputationEvidence | null;
  popularity: PopularityEvidence;
  probe: ProbeData | null;
}

// --- Agent responses ---

export interface AgentSummary {
  publicKeyHash: string;
  alias: string | null;
  firstSeen: number;
  lastSeen: number;
  source: AgentSource;
}

export interface AgentScoreResponse {
  agent: AgentSummary;
  bayesian: BayesianScoreBlock;
  stats: {
    totalTransactions: number;
    verifiedTransactions: number;
    uniqueCounterparties: number;
    attestationsReceived: number;
    avgAttestationScore: number;
  };
  evidence: ScoreEvidence;
  alerts: AgentAlert[];
}

export interface TopAgentsEntry {
  publicKeyHash: string;
  alias: string | null;
  rank: number | null;
  totalTransactions: number;
  source: AgentSource;
  bayesian: BayesianScoreBlock;
}

export interface TopAgentsResponse {
  agents: TopAgentsEntry[];
  meta: PaginationMeta & { sort_by?: string };
}

export type SearchAgentsEntry = TopAgentsEntry;

export interface SearchAgentsResponse {
  agents: SearchAgentsEntry[];
  meta: PaginationMeta;
}

/** Posterior history pending aggregate tables (Commit 8 placeholder kept for shape stability).
 *  `data` is always `[]` today; `bayesian` exposes the live posterior. */
export interface HistoryResponse {
  data: [];
  bayesian: BayesianScoreBlock;
  meta: PaginationMeta & { note?: string };
}

export interface AttestationRecord {
  attestationId: string;
  txId: string;
  attesterHash: string;
  score: number;
  tags: string[];
  evidenceHash: string | null;
  timestamp: number;
  category: AttestationCategory;
}

export interface AttestationsResponse {
  attestations: AttestationRecord[];
  meta: PaginationMeta;
}

export interface HealthResponse {
  status: 'ok' | 'error';
  agentsIndexed: number;
  staleAgents?: number;
  totalTransactions: number;
  lastUpdate: number;
  scoringAgeSec?: number | null;
  scoringStale?: boolean;
  uptime: number;
  schemaVersion: number;
  expectedSchemaVersion: number;
  dbStatus: 'ok' | 'error';
  lndStatus?: 'ok' | 'degraded' | 'unknown' | 'disabled';
  lndLastProbeAgeSec?: number | null;
  features?: {
    depositInvoiceGeneration: boolean;
    nostrPublishing: boolean;
    pathfindingProbe: boolean;
    nodeChannelHint: boolean;
  };
  cacheHealth?: {
    degraded: boolean;
    critical: Array<{ key: string; ageSec: number; consecutiveFailures: number }>;
  };
}

export interface NetworkStats {
  totalAgents: number;
  totalEndpoints: number;
  nodesProbed: number;
  phantomRate: number;
  verifiedReachable: number;
  probes24h: number;
  totalChannels: number;
  nodesWithRatings: number;
  networkCapacityBtc: number;
  totalVolumeBuckets: Record<AmountBucket, number>;
  serviceSources?: { '402index': number; 'self_registered': number; 'ad_hoc': number };
  trends?: NetworkTrends;
}

export interface VersionResponse {
  commit: string;
  buildDate: string;
  version: string;
}

// --- Trends ---

export type TrendDirection = 'rising' | 'stable' | 'falling';

/** Delta of the Bayesian p_success over rolling windows (range [-1, +1]). */
export interface ScoreDelta {
  delta24h: number | null;
  delta7d: number | null;
  delta30d: number | null;
  deltaValid: boolean;
  trend: TrendDirection;
}

export interface AgentAlert {
  type: 'score_drop' | 'score_surge' | 'new_agent' | 'inactive';
  message: string;
  severity: 'info' | 'warning' | 'critical';
}

export interface TopMover {
  publicKeyHash: string;
  alias: string | null;
  /** Bayesian posterior mean p_success ∈ [0, 1]. */
  pSuccess: number;
  /** 7d delta on p_success ∈ [-1, +1]. */
  delta7d: number;
  deltaValid: boolean;
  trend: TrendDirection;
}

export interface NetworkTrends {
  avgPSuccessDelta7d: number;
  topMoversUp: TopMover[];
  topMoversDown: TopMover[];
}

/** Posterior-delta movers land with the aggregate tables landing — until then,
 *  the server returns stable empty arrays so the envelope never shifts. */
export interface MoversResponse {
  gainers: TopMover[];
  losers: TopMover[];
}

// --- Verdict ---

export type VerdictFlag =
  | 'new_agent'
  | 'low_volume'
  | 'rapid_decline'
  | 'rapid_rise'
  | 'negative_reputation'
  | 'high_demand'
  | 'no_reputation_data'
  | 'fraud_reported'
  | 'dispute_reported'
  | 'unreachable'
  | 'unreachable_from_caller'
  | 'stale_gossip'
  | 'zombie_gossip'
  | 'capacity_drain'
  | 'severe_capacity_drain';

export interface PersonalTrust {
  distance: number | null;
  sharedConnections: number;
  strongestConnection: string | null;
}

export type RiskProfileName =
  | 'established_hub'
  | 'growing_node'
  | 'declining_node'
  | 'new_unproven'
  | 'small_reliable'
  | 'suspicious_rapid_rise'
  | 'unrated';

export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';

export interface RiskProfile {
  name: RiskProfileName;
  riskLevel: RiskLevel;
  description: string;
}

export interface PathfindingResult {
  reachable: boolean;
  hops: number | null;
  estimatedFeeMsat: number | null;
  alternatives: number;
  latencyMs: number;
  source: 'lnd_queryroutes';
  sourceNode?: string;
  sourceProvider?: WalletProvider;
}

/** VerdictResponse inherits the canonical BayesianScoreBlock. */
export interface VerdictResponse extends BayesianScoreBlock {
  reason: string;
  flags: VerdictFlag[];
  personalTrust: PersonalTrust | null;
  riskProfile: RiskProfile;
  pathfinding: PathfindingResult | null;
}

export type AttestationCategory =
  | 'successful_transaction'
  | 'failed_transaction'
  | 'dispute'
  | 'fraud'
  | 'unresponsive'
  | 'general';

export interface CreateAttestationInput {
  txId: string;
  attesterHash: string;
  subjectHash: string;
  score: number;
  tags?: string[];
  evidenceHash?: string;
  category?: AttestationCategory;
}

export interface CreateAttestationResponse {
  attestationId: string;
  timestamp: number;
}

export interface BatchVerdictItem extends VerdictResponse {
  publicKeyHash: string;
}

// --- Deposit ---

export interface DepositInvoiceResponse {
  invoice: string;
  paymentHash: string;
  amountSats: number;
  quotaGranted: number;
  expiresAt: number;
  instructions: string;
}

export interface DepositVerifyResponse {
  balance: number;
  paymentHash: string;
  token?: string;
  alreadyRedeemed?: boolean;
  instructions: string;
}

// --- Service discovery ---

export interface ServiceSearchParams {
  q?: string;
  category?: string;
  minScore?: number;
  minUptime?: number;
  sort?: 'p_success' | 'price' | 'uptime';
  limit?: number;
  offset?: number;
}

export interface ServiceResult {
  name: string | null;
  description: string | null;
  category: string | null;
  provider: string | null;
  url: string;
  priceSats: number | null;
  httpHealth: 'healthy' | 'degraded' | 'down' | null;
  uptimeRatio: number | null;
  latencyMs: number | null;
  lastCheckedAt: number | null;
  node: {
    publicKeyHash: string;
    alias: string | null;
    bayesian: BayesianScoreBlock | null;
  } | null;
}

export interface ServiceCategory {
  category: string;
  count: number;
}

// --- Decision types ---

export type ReportOutcome = 'success' | 'failure' | 'timeout';

export type WalletProvider = 'phoenix' | 'wos' | 'strike' | 'blink' | 'breez' | 'zeus' | 'coinos' | 'cashapp';

export interface DecideRequest {
  target: string;
  caller: string;
  amountSats?: number;
  walletProvider?: WalletProvider;
  callerNodePubkey?: string;
  serviceUrl?: string;
}

export type SurvivalPrediction = 'stable' | 'at_risk' | 'likely_dead';

export interface SurvivalResult {
  score: number;
  prediction: SurvivalPrediction;
  signals: {
    scoreTrajectory: string;
    probeStability: string;
    gossipFreshness: string;
  };
}

export interface ChannelFlow {
  net7d: number | null;
  capacityDelta7d: number | null;
  trend: 'growing' | 'stable' | 'declining';
}

export interface CapacityHealth {
  drainRate24h: number | null;
  drainRate7d: number | null;
  trend: 'growing' | 'stable' | 'declining';
}

export interface FeeVolatility {
  index: number;
  interpretation: 'stable' | 'moderate' | 'volatile';
  changesLast7d: number;
}

export interface ServiceHealth {
  url: string;
  status: 'healthy' | 'degraded' | 'down' | 'checking' | 'unknown';
  httpCode: number | null;
  latencyMs: number | null;
  uptimeRatio: number | null;
  lastCheckedAt: number | null;
  servicePriceSats: number | null;
}

/** DecideResponse inherits the canonical BayesianScoreBlock and adds
 *  operational fields (pathfinding, survival, serviceHealth, …). `components`
 *  here is the decide-specific axis (routable/available/pathQuality), not the
 *  retired composite components. */
export interface DecideResponse extends BayesianScoreBlock {
  go: boolean;
  successRate: number;
  components: {
    routable: number;
    available: number;
    pathQuality: number;
  };
  flags: VerdictFlag[];
  pathfinding: PathfindingResult | null;
  riskProfile: RiskProfile;
  reason: string;
  survival: SurvivalResult;
  targetFeeStability: number | null;
  maxRoutableAmount: number | null;
  reportedSuccessRate?: number | null;
  lastProbeAgeMs: number | null;
  serviceHealth: ServiceHealth | null;
  latencyMs: number;
}

export interface ReportRequest {
  target: string;
  reporter: string;
  outcome: ReportOutcome;
  paymentHash?: string;
  preimage?: string;
  amountBucket?: AmountBucket;
  memo?: string;
}

export interface ReportResponse {
  reportId: string;
  verified: boolean;
  weight: number;
  timestamp: number;
  bonus?: {
    credited: boolean;
    sats?: number;
    gate?: string;
  } | null;
}

export interface ProfileResponse {
  agent: {
    publicKeyHash: string;
    alias: string | null;
    publicKey: string | null;
    firstSeen: number;
    lastSeen: number;
    source: AgentSource;
  };
  bayesian: BayesianScoreBlock;
  rank: number | null;
  reports: {
    total: number;
    successes: number;
    failures: number;
    timeouts: number;
    successRate: number;
  };
  reporterStats?: {
    badge: 'novice' | 'reporter' | 'active_reporter' | 'trusted_reporter';
    submitted30d: number;
    verified30d: number;
    breakdown: { successes: number; failures: number; timeouts: number };
  };
  probeUptime: number | null;
  survival: SurvivalResult;
  channelFlow: ChannelFlow | null;
  capacityHealth: CapacityHealth | null;
  feeVolatility: FeeVolatility | null;
  riskProfile: RiskProfile;
  evidence: ScoreEvidence;
  flags: VerdictFlag[];
}

// --- Best Route ---

export interface BestRouteRequest {
  targets: string[];
  caller: string;
  amountSats?: number;
  walletProvider?: WalletProvider;
  callerNodePubkey?: string;
  serviceUrls?: Record<string, string>;
}

export interface BestRouteCandidate {
  publicKeyHash: string;
  alias: string | null;
  bayesian: BayesianScoreBlock;
  pathfinding: PathfindingResult;
}

export interface BestRouteResponse {
  candidates: BestRouteCandidate[];
  totalQueried: number;
  reachableCount: number;
  unreachableCount: number;
  pathfindingContext: string;
  latencyMs: number;
}

// --- Transact ---

export interface PaymentResult {
  success: boolean;
  preimage?: string;
  paymentHash?: string;
}

export interface TransactResult {
  paid: boolean;
  decision: DecideResponse;
  report?: ReportResponse | null;
}
