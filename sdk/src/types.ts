// SatRank API v1 response types
// Decoupled from server — do not import from ../src/

export type AgentSource = 'observer_protocol' | '4tress' | 'lightning_graph' | 'manual';
export type ConfidenceLevel = 'very_low' | 'low' | 'medium' | 'high' | 'very_high';
export type AmountBucket = 'micro' | 'small' | 'medium' | 'large';
export type PaymentProtocol = 'l402' | 'keysend' | 'bolt11';

export interface PaginationMeta {
  total: number;
  limit: number;
  offset: number;
}

export interface ScoreComponents {
  volume: number;
  reputation: number;
  seniority: number;
  regularity: number;
  diversity: number;
}

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

export interface TopAgentsResponse {
  agents: {
    publicKeyHash: string;
    alias: string | null;
    score: number;
    totalTransactions: number;
    source: AgentSource;
  }[];
  meta: PaginationMeta;
}

export interface SearchAgentsResponse {
  agents: {
    publicKeyHash: string;
    alias: string | null;
    score: number;
    source: AgentSource;
  }[];
  meta: PaginationMeta;
}

export interface HistoryResponse {
  snapshots: {
    score: number;
    components: ScoreComponents;
    computedAt: number;
  }[];
  meta: PaginationMeta;
}

export interface AttestationsResponse {
  attestations: {
    attestationId: string;
    txId: string;
    attesterHash: string;
    score: number;
    tags: string[];
    evidenceHash: string | null;
    timestamp: number;
    category: AttestationCategory;
  }[];
  meta: PaginationMeta;
}

export interface HealthResponse {
  status: 'ok' | 'error';
  agentsIndexed: number;
  totalTransactions: number;
  lastUpdate: number;
  uptime: number;
  schemaVersion: number;
  expectedSchemaVersion: number;
  dbStatus: 'ok' | 'error';
}

export interface NetworkStats {
  totalAgents: number;
  totalChannels: number;
  nodesWithRatings: number;
  networkCapacityBtc: number;
  avgScore: number;
  totalVolumeBuckets: Record<AmountBucket, number>;
  trends: NetworkTrends;
}

export interface VersionResponse {
  commit: string;
  buildDate: string;
  version: string;
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
  | 'unreachable_from_caller';

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

// Personalized pathfinding — real-time route query from caller to target
export interface PathfindingResult {
  reachable: boolean;
  hops: number | null;
  estimatedFeeMsat: number | null;
  alternatives: number;
  latencyMs: number;
  source: 'lnd_queryroutes';
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

export interface MoversResponse {
  up: TopMover[];
  down: TopMover[];
}

// --- v2 types ---

export type ReportOutcome = 'success' | 'failure' | 'timeout';

export interface DecideRequest {
  target: string;
  caller: string;
  amountSats?: number;
  intent?: 'pay' | 'receive';
}

export interface DecideResponse {
  go: boolean;
  successRate: number;
  components: {
    trustScore: number;
    routable: number;
    available: number;
    empirical: number;
  };
  basis: 'proxy' | 'empirical';
  confidence: ConfidenceLevel;
  verdict: Verdict;
  flags: VerdictFlag[];
  pathfinding: PathfindingResult | null;
  riskProfile: RiskProfile;
  reason: string;
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
  delta: ScoreDelta;
  riskProfile: RiskProfile;
  evidence: ScoreEvidence;
  flags: VerdictFlag[];
}
