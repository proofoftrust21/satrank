// Scoring engine configuration — all tunable constants in one place
// Changing these values affects score computation for all agents.

// --- Component weights (must sum to 1.0) ---

/** Weight of transaction volume in the composite score */
export const WEIGHT_VOLUME = 0.25;
/** Weight of reputation (attestations or LN+ ratings) */
export const WEIGHT_REPUTATION = 0.30;
/** Weight of time on the network */
export const WEIGHT_SENIORITY = 0.15;
/** Weight of transaction regularity pattern */
export const WEIGHT_REGULARITY = 0.15;
/** Weight of counterparty diversity */
export const WEIGHT_DIVERSITY = 0.15;

export const WEIGHTS = {
  volume: WEIGHT_VOLUME,
  reputation: WEIGHT_REPUTATION,
  seniority: WEIGHT_SENIORITY,
  regularity: WEIGHT_REGULARITY,
  diversity: WEIGHT_DIVERSITY,
} as const;

// --- Attestation decay ---

/** Half-life for exponential decay of attestation weights (seconds). 30 days. */
export const ATTESTATION_HALF_LIFE = 30 * 24 * 3600;

/** Minimum age (days) for an attester to be considered credible */
export const MIN_ATTESTER_AGE_DAYS = 7;

/** Weight multiplier for attesters with score 0 (anti-sybil) */
export const UNKNOWN_ATTESTER_WEIGHT = 0.1;

/** Weight multiplier for attesters younger than MIN_ATTESTER_AGE_DAYS */
export const YOUNG_ATTESTER_WEIGHT = 0.05;

// --- Anti-gaming ---

/** Weight multiplier for direct mutual attestations (A<->B). Nearly eliminated. */
export const MUTUAL_ATTESTATION_PENALTY = 0.05;

/** Score ceiling for suspect attestations (mutual or circular cluster) */
export const SUSPECT_ATTESTATION_SCORE_CAP = 40;

/** Weight multiplier for circular cluster attestations (A->B->C->A) */
export const CIRCULAR_CLUSTER_PENALTY = 0.1;

/** Transaction count at which the "manual" source penalty reaches 1.0 */
export const MANUAL_SOURCE_PENALTY_THRESHOLD = 150;

/** Minimum penalty multiplier for manual-source agents with 0 transactions */
export const MANUAL_SOURCE_MIN_MULTIPLIER = 0.5;

// --- Verified transaction bonus ---

/** Max bonus points from verified Observer Protocol transactions */
export const VERIFIED_TX_BONUS_CAP = 15;

/** Points per verified transaction (before cap) */
export const VERIFIED_TX_BONUS_PER_TX = 0.5;

// --- Lightning graph scoring ---

/** Headroom multiplier above max network channels (so top node scores ~95, not 100) */
export const LN_VOLUME_HEADROOM = 1.1;

/** Power curve exponent for Lightning channel distribution scaling */
export const LN_VOLUME_POWER = 0.4;

/** Decay constant for Lightning node recency scoring (days) */
export const LN_REGULARITY_DECAY_DAYS = 30;

/** Satoshi-to-BTC conversion factor */
export const SATS_PER_BTC = 100_000_000;

/** Logarithmic denominator for capacity-based diversity scoring */
export const LN_DIVERSITY_LOG_BASE = 1001;

/** Multiplier applied to BTC capacity before log scaling */
export const LN_DIVERSITY_BTC_MULTIPLIER = 10;

// --- LN+ reputation formula ---

/** Points per LN+ rank level (0-10 scale -> max 50 points) */
export const LNPLUS_RANK_MULTIPLIER = 5;

/** Max points from positive/negative ratings ratio */
export const LNPLUS_RATINGS_WEIGHT = 50;

/** Penalty weight for negative ratings: score -= (neg / (pos + neg + 1)) * this */
export const NEGATIVE_RATINGS_PENALTY = 20;

/** Centrality bonus multiplier (applied to exp decay) */
export const CENTRALITY_BONUS_MULTIPLIER = 5;

/** Exponential decay constant for centrality rank scoring */
export const CENTRALITY_DECAY_CONSTANT = 50;

// --- Observer protocol scoring ---

/** Logarithmic denominator for transaction volume scoring */
export const VOLUME_LOG_BASE = 1001;

/** Logarithmic denominator for counterparty diversity scoring */
export const DIVERSITY_LOG_BASE = 51;

/** Half-life for seniority exponential growth curve (days) */
export const SENIORITY_HALF_LIFE_DAYS = 180;

// --- Confidence thresholds ---
// dataPoints = totalTransactions + totalAttestations

/** Below this: very_low confidence */
export const CONFIDENCE_VERY_LOW = 5;
/** Below this: low confidence */
export const CONFIDENCE_LOW = 20;
/** Below this: medium confidence */
export const CONFIDENCE_MEDIUM = 100;
/** Below this: high confidence; above: very_high */
export const CONFIDENCE_HIGH = 500;

// --- Attestation limits ---

/** Maximum attestations loaded per agent for reputation computation.
 *  If an agent exceeds this limit, only the most recent attestations are used
 *  and a warning is logged. Increase for agents with very high attestation volume. */
export const MAX_ATTESTATIONS_PER_AGENT = 1000;

// --- Cache ---

/** Minimum time between score recomputations (seconds) */
export const SCORE_CACHE_TTL = 300;

// --- Popularity ---

/** Maximum bonus points from query-based popularity */
export const POPULARITY_BONUS_CAP = 10;

/** Multiplier applied to log2(queryCount+1) */
export const POPULARITY_LOG_MULTIPLIER = 2;

// --- Probe routing ---

/** Penalty applied to total score when node is unreachable (subtracted) */
export const PROBE_UNREACHABLE_PENALTY = 10;

/** Bonus for low-latency probes (< 500ms response) */
export const PROBE_LOW_LATENCY_BONUS = 3;

/** Bonus for short hop routes (≤ 3 hops) */
export const PROBE_SHORT_HOP_BONUS = 2;

/** Max age (seconds) for probe data to be considered fresh for scoring. 24h. */
export const PROBE_FRESHNESS_TTL = 86_400;
