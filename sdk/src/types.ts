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

export interface ScoreEvidence {
  transactions: {
    count: number;
    verifiedCount: number;
    sample: TransactionSample[];
  };
  lightningGraph: LightningGraphEvidence | null;
  reputation: ReputationEvidence | null;
  popularity: PopularityEvidence;
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
  }[];
  meta: PaginationMeta;
}

export interface HealthResponse {
  status: 'ok' | 'error';
  agentsIndexed: number;
  totalTransactions: number;
  lastUpdate: number;
  uptime: number;
}

export interface NetworkStats {
  totalAgents: number;
  totalTransactions: number;
  totalAttestations: number;
  avgScore: number;
  totalVolumeBuckets: Record<AmountBucket, number>;
}

export interface VersionResponse {
  commit: string;
  buildDate: string;
  version: string;
}
