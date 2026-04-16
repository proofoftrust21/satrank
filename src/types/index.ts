// Core SatRank types

export type AgentSource = 'observer_protocol' | '4tress' | 'lightning_graph' | 'manual';
export type TransactionStatus = 'verified' | 'pending' | 'failed' | 'disputed';
export type AmountBucket = 'micro' | 'small' | 'medium' | 'large';
export type PaymentProtocol = 'l402' | 'keysend' | 'bolt11';

// Database entities
export interface Agent {
  public_key_hash: string;
  public_key: string | null;
  alias: string | null;
  first_seen: number;
  last_seen: number;
  source: AgentSource;
  total_transactions: number;
  total_attestations_received: number;
  avg_score: number;
  capacity_sats: number | null;
  positive_ratings: number;
  negative_ratings: number;
  lnplus_rank: number;
  hubness_rank: number;
  betweenness_rank: number;
  hopness_rank: number;
  query_count: number;
  unique_peers: number | null;
  last_queried_at: number | null;
  /** Number of channel directions marked disabled in gossip policies. Updated hourly by the graph crawler. SQL DEFAULT 0. */
  disabled_channels?: number;
  /** Sovereign PageRank score (percentile 0-100). Computed hourly from the full LND graph. SQL DEFAULT NULL. */
  pagerank_score?: number | null;
  /** 1 when the agent has not been seen in 90+ days (fossil). Soft-flagged; restored to 0 on next sighting. */
  stale?: number;
}

export interface Transaction {
  tx_id: string;
  sender_hash: string;
  receiver_hash: string;
  amount_bucket: AmountBucket;
  timestamp: number;
  payment_hash: string;
  preimage: string | null;
  status: TransactionStatus;
  protocol: PaymentProtocol;
}

export type AttestationCategory = 'successful_transaction' | 'failed_transaction' | 'dispute' | 'fraud' | 'unresponsive' | 'general';

export interface Attestation {
  attestation_id: string;
  tx_id: string;
  attester_hash: string;
  subject_hash: string;
  score: number;
  tags: string | null;
  evidence_hash: string | null;
  timestamp: number;
  category: AttestationCategory;
  verified: number; // SQLite boolean: 0 or 1
  weight: number;
}

export interface ScoreSnapshot {
  snapshot_id: string;
  agent_hash: string;
  score: number;
  components: string;
  computed_at: number;
}

// Probe results — stored in probe_results table
export interface ProbeResult {
  id: number;
  target_hash: string;
  probed_at: number;
  reachable: number; // SQLite boolean: 0 or 1
  latency_ms: number | null;
  hops: number | null;
  estimated_fee_msat: number | null;
  failure_reason: string | null;
  /** Amount in sats used for this probe (1000, 10000, 100000, 1000000). Added in v20. */
  probe_amount_sats?: number;
}

// Detailed score components
export interface ScoreComponents {
  volume: number;
  reputation: number;
  seniority: number;
  regularity: number;
  diversity: number;
}

// Confidence level derived from the score
export type ConfidenceLevel = 'very_low' | 'low' | 'medium' | 'high' | 'very_high';

// API responses
export interface AgentScoreResponse {
  agent: {
    publicKeyHash: string;
    alias: string | null;
    firstSeen: number;
    lastSeen: number;
    source: AgentSource;
  };
  score: {
    total: number;
    components: ScoreComponents;
    confidence: ConfidenceLevel;
    computedAt: number;
  };
  stats: {
    totalTransactions: number;
    verifiedTransactions: number;
    uniqueCounterparties: number;
    attestationsReceived: number;
    avgAttestationScore: number;
  };
  evidence: ScoreEvidence;
  delta: ScoreDelta;
  alerts: AgentAlert[];
}

export interface TransactionSample {
  txId: string;
  protocol: PaymentProtocol;
  amountBucket: AmountBucket;
  verified: boolean;
  timestamp: number;
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
  lightningGraph: {
    publicKey: string;
    channels: number;
    capacitySats: number;
    sourceUrl: string;
  } | null;
  reputation: {
    positiveRatings: number;
    negativeRatings: number;
    lnplusRank: number;
    hubnessRank: number;
    betweennessRank: number;
    sourceUrl: string;
  } | null;
  popularity: {
    queryCount: number;
    bonusApplied: number;
  };
  probe: ProbeData | null;
}

export interface PaginationParams {
  limit: number;
  offset: number;
}

export interface HealthResponse {
  status: 'ok' | 'error';
  agentsIndexed: number;
  /** Fossils — agents not seen in 90+ days. Kept in DB but excluded from scoring/publishing. */
  staleAgents: number;
  totalTransactions: number;
  lastUpdate: number;
  uptime: number;
  schemaVersion: number;
  expectedSchemaVersion: number;
  dbStatus: 'ok' | 'error';
  /** Optional features that may be silently disabled if env vars are missing. */
  features?: {
    depositInvoiceGeneration: boolean;
    nostrPublishing: boolean;
    pathfindingProbe: boolean;
    nodeChannelHint: boolean;
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
  avgScore: number;
  totalVolumeBuckets: Record<AmountBucket, number>;
  trends: NetworkTrends;
}

// Temporal delta types
export type TrendDirection = 'rising' | 'stable' | 'falling';

export interface ScoreDelta {
  delta24h: number | null;
  delta7d: number | null;
  delta30d: number | null;
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
  score: number;
  delta7d: number;
  trend: TrendDirection;
}

export interface NetworkTrends {
  avgScoreDelta7d: number;
  topMoversUp: TopMover[];
  topMoversDown: TopMover[];
}

export interface CreateAttestationInput {
  txId: string;
  attesterHash: string;
  subjectHash: string;
  score: number;
  tags?: string[];
  evidenceHash?: string;
  category?: AttestationCategory;
}

// Verdict types
export type Verdict = 'SAFE' | 'RISKY' | 'UNKNOWN';

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
  | 'default';

export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';

export interface RiskProfile {
  name: RiskProfileName;
  riskLevel: RiskLevel;
  description: string;
}

// Personalized pathfinding — real-time route query from caller to target via LND
export interface PathfindingResult {
  reachable: boolean;
  hops: number | null;
  estimatedFeeMsat: number | null;
  alternatives: number;
  latencyMs: number;
  source: 'lnd_queryroutes';
  /** The node used as pathfinding source. 'provider:<name>' for walletProvider, pubkey for callerNodePubkey, 'satrank' for default. */
  sourceNode?: string;
}

export interface VerdictResponse {
  verdict: Verdict;
  confidence: number;
  reason: string;
  flags: VerdictFlag[];
  personalTrust: PersonalTrust | null;
  riskProfile: RiskProfile;
  pathfinding: PathfindingResult | null;
}

// --- v2 types ---

export type ReportOutcome = 'success' | 'failure' | 'timeout';

export type WalletProvider = 'phoenix' | 'wos' | 'strike' | 'blink' | 'breez' | 'zeus' | 'coinos' | 'cashapp';

export interface DecideRequest {
  target: string;
  caller: string;
  amountSats?: number;
  walletProvider?: WalletProvider;
  callerNodePubkey?: string;
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

export interface ServiceHealth {
  url: string;
  status: 'healthy' | 'degraded' | 'down' | 'checking' | 'unknown';
  httpCode: number | null;
  latencyMs: number | null;
  uptimeRatio: number | null;
  lastCheckedAt: number | null;
  /** Price of the service in sats (from BOLT11 invoice), null if unknown */
  servicePriceSats: number | null;
}

export interface FeeVolatility {
  index: number;
  interpretation: 'stable' | 'moderate' | 'volatile';
  changesLast7d: number;
}

export interface DecideResponse {
  go: boolean;
  successRate: number;
  components: {
    trustScore: number;
    routable: number;
    available: number;
    empirical: number;
    pathQuality: number;
  };
  basis: 'proxy' | 'empirical';
  confidence: ConfidenceLevel;
  verdict: Verdict;
  flags: VerdictFlag[];
  pathfinding: PathfindingResult | null;
  riskProfile: RiskProfile;
  reason: string;
  survival: SurvivalResult;
  /** Fee stability of the target node only (not the full route). 0 = highly volatile, 1 = perfectly stable. null when no fee data. */
  targetFeeStability: number | null;
  /** Highest amount (sats) for which a route was found in recent probes. null if no multi-amount data. */
  maxRoutableAmount: number | null;
  /** Raw empirical success rate from payment reports (0-1). null when insufficient reports (<10 data points or <5 unique reporters). */
  reportedSuccessRate: number | null;
  lastProbeAgeMs: number | null;
  /** HTTP health of the service behind this node. null when no serviceUrl provided or no data available. */
  serviceHealth: ServiceHealth | null;
  latencyMs: number;
}

export interface BestRouteCandidate {
  publicKeyHash: string;
  alias: string | null;
  score: number;
  verdict: Verdict;
  pathfinding: PathfindingResult;
}

export interface BestRouteResponse {
  candidates: BestRouteCandidate[];
  totalQueried: number;
  reachableCount: number;
  unreachableCount: number;
  /** Explains that reachability depends on SatRank's graph position, not target quality. */
  pathfindingContext: string;
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
  score: {
    total: number;
    components: ScoreComponents;
    confidence: ConfidenceLevel;
    rank: number | null;
  };
  reports: {
    total: number;
    successes: number;
    failures: number;
    timeouts: number;
    successRate: number;
  };
  probeUptime: number | null;
  survival: SurvivalResult;
  channelFlow: ChannelFlow | null;
  capacityHealth: CapacityHealth | null;
  feeVolatility: FeeVolatility | null;
  delta: ScoreDelta;
  riskProfile: RiskProfile;
  evidence: ScoreEvidence;
  flags: VerdictFlag[];
}
