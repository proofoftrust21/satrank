// Core SatRank types

export type AgentSource = 'attestation' | '4tress' | 'lightning_graph' | 'manual';
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

/** Bayesian posterior snapshot (Phase 3 C8). The legacy `score` +
 *  `components` columns were dropped in v34; this shape reflects the new
 *  bayesian-only schema. Historical rows written before v34 have all
 *  bayesian fields null — queries in SnapshotRepository filter these out. */
export interface ScoreSnapshot {
  snapshot_id: string;
  agent_hash: string;
  p_success: number;
  ci95_low: number;
  ci95_high: number;
  n_obs: number;
  posterior_alpha: number;
  posterior_beta: number;
  window: BayesianWindow;
  computed_at: number;
  updated_at: number;
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
  /** Attribution of the Reputation component to its internal sub-signals so a
   *  client can answer "why did Reputation move by X points?". Optional on old
   *  snapshots that predate the 2026-04-16 instrumentation. */
  reputationBreakdown?: ReputationBreakdown;
}

/** Decomposition of the Reputation component into its sub-signals.
 *  `contribution` = `value × weight` for each slot; the sum equals the
 *  Reputation component (modulo rounding). Each slot carries its own
 *  `weight` so the operator can see the formula, not just the numbers. */
export interface ReputationBreakdown {
  mode: 'lightning_graph' | 'attestations';
  /** Populated for `lightning_graph` agents. */
  subsignals?: {
    centrality:      SubSignalContribution & { source: 'pagerank' | 'lnplus_ranks' | 'none' };
    peerTrust:       SubSignalContribution;
    routingQuality:  SubSignalContribution;
    capacityTrend:   SubSignalContribution;
    feeStability:    SubSignalContribution;
  };
  /** Populated for `attestations` agents (attestation / manual). */
  attestations?: {
    /** Number of non-report attestations used in the weighted average. */
    count: number;
    /** Time-decay-weighted average of attester scores (0-100). */
    weightedAverage: number;
    /** Additional signal from `/api/report` outcomes (see REPORT_SIGNAL_CAP). */
    reportSignal: number;
  };
}

export interface SubSignalContribution {
  /** Raw sub-signal score 0-100. */
  value: number;
  /** Weight inside the Reputation formula AFTER dynamic renormalization for
   *  missing signals. Available weights sum to ~1.0; unavailable slots have
   *  weight 0 and are excluded from the score. */
  weight: number;
  /** value × weight, in the same 0-100 space as the Reputation component. */
  contribution: number;
  /** False when the sub-signal has no observable data (e.g. peerTrust on a
   *  node with no channels, centrality on a pre-PageRank-crawl agent). When
   *  false, the slot is excluded from the weighted average and its nominal
   *  weight is redistributed to the available slots so the Reputation score
   *  reflects what was actually measured. */
  available?: boolean;
}

// Confidence level derived from the score
export type ConfidenceLevel = 'very_low' | 'low' | 'medium' | 'high' | 'very_high';

// API responses
/** Agent profile: identity + stats + evidence overlay + canonical Bayesian
 *  block. No composite score surface — `bayesian` is the source of truth. */
export interface AgentScoreResponse {
  agent: {
    publicKeyHash: string;
    alias: string | null;
    firstSeen: number;
    lastSeen: number;
    source: AgentSource;
  };
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
  /** Seconds since `lastUpdate`. Exposed so external monitoring can alert
   *  without knowing current wall clock. Null when no snapshot exists yet. */
  scoringAgeSec?: number | null;
  /** True when the crawler hasn't written a score snapshot in > 2h. Flips
   *  `status` to `error` even when the DB and caches look healthy. */
  scoringStale?: boolean;
  uptime: number;
  schemaVersion: number;
  expectedSchemaVersion: number;
  dbStatus: 'ok' | 'error';
  /** LND reachability. `disabled` = LND not configured, `unknown` = cold start
   *  (no probe yet), `ok` = last probe succeeded, `degraded` = 3+ consecutive
   *  getInfo() failures. `degraded` flips `status` to `error`. */
  lndStatus?: 'ok' | 'degraded' | 'unknown' | 'disabled';
  /** Seconds since the last LND probe (success OR failure). Null when LND is disabled
   *  or no probe has run yet. Paired with `lndStatus` to detect staleness. */
  lndLastProbeAgeSec?: number | null;
  /** Optional features that may be silently disabled if env vars are missing. */
  features?: {
    depositInvoiceGeneration: boolean;
    nostrPublishing: boolean;
    pathfindingProbe: boolean;
    nodeChannelHint: boolean;
  };
  /** Cache health summary for critical caches.
   *  degraded = any critical cache has ageSec > its TTL × 3 OR consecutiveFailures ≥ 3.
   *  This flags silent staleness (background refresh failing) that would otherwise be invisible. */
  cacheHealth?: {
    degraded: boolean;
    critical: Array<{ key: string; ageSec: number; consecutiveFailures: number }>;
  };
}

export interface NetworkStats {
  totalAgents: number;
  totalEndpoints: number;
  /** Phase 7.3 — count of non-deprecated L402 endpoints in
   *  service_endpoints. Distinct from `totalEndpoints` (which counts
   *  Lightning nodes from the gossip graph). The landing page surfaces
   *  this as the "L402 endpoints" stat. */
  serviceEndpointCount: number;
  nodesProbed: number;
  phantomRate: number;
  verifiedReachable: number;
  probes24h: number;
  totalChannels: number;
  nodesWithRatings: number;
  networkCapacityBtc: number;
  totalVolumeBuckets: Record<AmountBucket, number>;
  /** Distribution of service_endpoints entries per source (trust classification).
   *  402index = crawler-verified, self_registered = operator-submitted, ad_hoc = observed via /api/decide. */
  serviceSources: { '402index': number; 'self_registered': number; 'ad_hoc': number };
}

// Temporal delta types
export type TrendDirection = 'rising' | 'stable' | 'falling';

/** Delta of the Bayesian p_success over rolling windows. Numeric range
 *  [-1, +1] since p_success ∈ [0, 1]. `deltaValid` is kept on the envelope
 *  for SDK compat and flips to false only when no 7d comparator exists
 *  (cold start); it is NOT tied to any methodology cutoff in the bayesian
 *  world — Phase 3 replaced the composite regime outright. */
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
  /** Bayesian posterior mean p_success ∈ [0, 1], 3 decimals. */
  pSuccess: number;
  /** 7d delta on p_success ∈ [-1, +1], 3 decimals. */
  delta7d: number;
  /** Kept on the envelope for SDK compat — always true post-Phase 3. */
  deltaValid: boolean;
  trend: TrendDirection;
}

export interface NetworkTrends {
  /** 7d delta on the mean p_success across active agents. */
  avgPSuccessDelta7d: number;
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

// Verdict types — Bayesian (Phase 3)
export type Verdict = 'SAFE' | 'RISKY' | 'UNKNOWN' | 'INSUFFICIENT';
export type BayesianWindow = '24h' | '7d' | '30d';
export type BayesianSource = 'probe' | 'report' | 'paid';

/** Per-source Bayesian posterior block — null when no observation for that source. */
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

/** n_obs cumulé sur les 3 fenêtres d'affichage — lu depuis daily_buckets, toutes sources.
 *  Display-only, indépendant du verdict. */
export interface BayesianRecentActivity {
  last_24h: number;
  last_7d: number;
  last_30d: number;
}

/** Trend delta success_rate (low/medium/high/unknown) — Option B. */
export type BayesianRiskTrend = 'low' | 'medium' | 'high' | 'unknown';

/** Canonical Bayesian scoring block — shared shape across all public endpoints
 *  (verdict, intent, profile, service, endpoint). Phase 3 C9 : le champ
 *  `window` a disparu (streaming, τ=7j implicite), remplacé par
 *  `time_constant_days`, `recent_activity`, `risk_profile`, `last_update`. */
export interface BayesianScoreBlock {
  p_success: number;
  ci95_low: number;
  ci95_high: number;
  n_obs: number;
  verdict: Verdict;
  sources: {
    probe:  BayesianSourceBlock | null;
    report: BayesianSourceBlock | null;
    paid:   BayesianSourceBlock | null;
  };
  convergence: BayesianConvergence;
  /** n_obs cumulé 24h/7d/30d (toutes sources). */
  recent_activity: BayesianRecentActivity;
  /** Trend success_rate 7j récents vs 23j antérieurs — Option B. */
  risk_profile: BayesianRiskTrend;
  /** Constante τ exposée (décroissance exponentielle, jours). */
  time_constant_days: number;
  /** Unix seconds de la dernière ingestion connue — 0 si aucune observation. */
  last_update: number;
  /** Vague 1 B — true when the posterior aggregates enough recent evidence
   *  to drive an agent decision, false when it is mostly the prior shining
   *  through (insufficient probes and/or stale data). When false, callers
   *  should treat p_success / ci95_* as a prior-dominated estimate, not a
   *  measurement, and prefer paying ?fresh=true for a synchronous probe.
   *
   *  Computation lives in intentService.formatCandidate so it can combine
   *  freshness_status with n_obs; downstream services (verdict, decide)
   *  default to true for backwards compatibility when they have no
   *  freshness_status to consult. Non-breaking: the field is additive. */
  is_meaningful: boolean;
}

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

// Personalized pathfinding — real-time route query from caller to target via LND
export interface PathfindingResult {
  reachable: boolean;
  hops: number | null;
  estimatedFeeMsat: number | null;
  alternatives: number;
  latencyMs: number;
  /** Pathfinding engine used. Always 'lnd_queryroutes' today. */
  source: 'lnd_queryroutes';
  /** Node (raw pubkey) used as pathfinding origin, or 'satrank' for default position. */
  sourceNode?: string;
  /** Wallet provider label when walletProvider= was supplied. Undefined otherwise. */
  sourceProvider?: WalletProvider;
}

export interface VerdictResponse extends BayesianScoreBlock {
  reason: string;
  flags: VerdictFlag[];
  personalTrust: PersonalTrust | null;
  riskProfile: RiskProfile;
  pathfinding: PathfindingResult | null;
  // Phase 4 — advisory overlay (orthogonal to the Bayesian verdict).
  advisory_level: AdvisoryLevel;
  risk_score: number;
  advisories: Advisory[];
  /** Phase 4 P6 — uptime probe ratio in [0, 1] on the same 7d window the advisory uses.
   *  null when no probes yet. Complements the binary `unreachable` flag. */
  reachability: number | null;
  /** Phase 7 C11 — operator_id de l'operator qui possède ce node, **uniquement
   *  si son status='verified'**. null si le node n'est rattaché à aucun operator,
   *  OU si l'operator est pending/rejected. Zéro auto-trust : on n'expose pas
   *  un rattachement non-vérifié comme s'il était une identité. */
  operator_id: string | null;
}

// Phase 4 — graduated advisory overlay. `advisory_level` sits alongside
// `verdict` (Bayesian 4-class label) and adds a continuous risk perspective
// so agent consumers can nuance proceed/abort decisions.
/** Axe 1 — `insufficient_freshness` is a 5th level *less safe* than green
 *  but more diagnostic than yellow: the posterior would be green, but the
 *  underlying HTTP probe is staler than the hot-tier cadence (1h). The
 *  signal is "we genuinely don't know if it still works." */
export type AdvisoryLevel = 'green' | 'yellow' | 'orange' | 'red' | 'insufficient_freshness';

export type AdvisoryCode =
  | 'CRITICAL_FLAG'
  | 'LOW_REACHABILITY'
  | 'UNCERTAIN_POSTERIOR'
  | 'POSTERIOR_DECLINE'
  | 'LOW_UPTIME'
  | 'DEGRADED_HTTP'
  | 'STALE_HEALTH'
  | 'INTERMITTENT'
  /** Phase 7 C12 — la ressource (node ou endpoint) est rattachée à un operator
   *  dont le status ≠ 'verified' (pending ou rejected). Signalé pour éviter
   *  l'auto-trust via un rattachement non-prouvé. */
  | 'OPERATOR_UNVERIFIED'
  /** Axe 1 — last HTTP probe is older than the hot-tier cadence (1h). The
   *  posterior could be optimistic because we haven't re-verified the
   *  endpoint recently. Drives the `insufficient_freshness` advisory level. */
  | 'INSUFFICIENT_FRESHNESS';

export interface Advisory {
  code: AdvisoryCode;
  level: 'info' | 'warning' | 'critical';
  msg: string;
  /** Continuous [0, 1] — how strongly this signal fires. 0 = silent, 1 = fully active. */
  signal_strength: number;
  /** Optional structured payload for programmatic agent consumers. */
  data?: Record<string, unknown>;
}

export interface AdvisoryReport {
  advisory_level: AdvisoryLevel;
  /** Continuous aggregate [0, 1], 0 = green, 1 = red. Paliers < 0.15 / 0.35 / 0.60 → green/yellow/orange/red. */
  risk_score: number;
  advisories: Advisory[];
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
  serviceUrl?: string;
}

export interface ReportResponseEnvelope {
  reportId: string;
  verified: boolean;
  weight: number;
  timestamp: number;
  bonus: { credited: boolean; sats?: number; gate?: string } | null;
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
  /** Phase 4 P6 — graduated HTTP health in [0, 1] derived from status +
   *  uptimeRatio. 1.0 = fully healthy, 0 = down. Continuous complement to the
   *  discrete `status`; null when no data (status = 'checking'|'unknown'). */
  httpHealthScore: number | null;
  /** Phase 4 P6 — exp(-age/600) decay on lastCheckedAt, null if no check yet.
   *  1.0 = just checked, ~0.37 at 10 min, ~0.14 at 20 min. Lets agents decay
   *  their trust in the cached health instead of the old binary 5-min flag. */
  healthFreshness: number | null;
}

export interface FeeVolatility {
  index: number;
  interpretation: 'stable' | 'moderate' | 'volatile';
  changesLast7d: number;
}

/** `extends BayesianScoreBlock` → inherits {p_success, ci95_low, ci95_high, n_obs,
 *  verdict, window, sources, convergence} — the canonical public shape shared
 *  with /verdict, /profile, /service, /endpoint. */
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
  /** Fee stability of the target node only (not the full route). 0 = highly volatile, 1 = perfectly stable. null when no fee data. */
  targetFeeStability: number | null;
  /** Highest amount (sats) for which a route was found in recent probes. null if no multi-amount data. */
  maxRoutableAmount: number | null;
  lastProbeAgeMs: number | null;
  /** HTTP health of the service behind this node. null when no serviceUrl provided or no data available. */
  serviceHealth: ServiceHealth | null;
  latencyMs: number;
  // Phase 4 — advisory overlay mirrored from /verdict.
  advisory_level: AdvisoryLevel;
  risk_score: number;
  advisories: Advisory[];
  // Phase 4 — tiered recommendation, calibrated on verdict + advisory + ci95.
  recommendation: Recommendation;
}

export type Recommendation = 'proceed' | 'proceed_with_caution' | 'consider_alternative' | 'avoid';

export interface ReportRequest {
  target: string;
  reporter: string;
  outcome: ReportOutcome;
  paymentHash?: string;
  preimage?: string;
  amountBucket?: AmountBucket;
  memo?: string;
  /** Raw sha256 digest of the L402 Authorization preimage, when the caller
   *  is using L402 auth. Populated by the v2Controller from the request's
   *  Authorization header; undefined for API-key auth / direct callers.
   *  ReportService cross-references this against `token_query_log` to tag
   *  the tx row as `source='intent'` when the report closes out a prior
   *  paid target query. */
  l402PaymentHash?: Buffer;
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
    confidence: number;
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
