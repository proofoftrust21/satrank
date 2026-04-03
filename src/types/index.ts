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
}

export interface ScoreSnapshot {
  snapshot_id: string;
  agent_hash: string;
  score: number;
  components: string;
  computed_at: number;
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
}

export interface PaginationParams {
  limit: number;
  offset: number;
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
  | 'dispute_reported';

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

export interface VerdictResponse {
  verdict: Verdict;
  confidence: number;
  reason: string;
  flags: VerdictFlag[];
  personalTrust: PersonalTrust | null;
  riskProfile: RiskProfile;
}
