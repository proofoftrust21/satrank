// Phase 11B.2 (2026-05-04) — Agent reputation storage.
//
// Per autonomy audit 2026-05-04 (lens L2). Per-agent profile tracking
// total fulfills + outcomes + cached Bayesian score + tier label.
// Updates happen via the upsert path (AgentReputationService) so the
// row exists from first /api/fulfill onwards.
//
// Score / tier computation is JS-side (computeReputationScore +
// computeTier exported below) so the SQL stays simple and the same
// formula is used by repository.recordOutcome and the read-only API.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type ReputationTier = 'bronze' | 'silver' | 'gold';

export interface AgentProfile {
  agent_pubkey: string;
  total_fulfills: number;
  successful_fulfills: number;
  refunded_fulfills: number;
  validator_violations: number;
  reputation_score: number;
  reputation_tier: ReputationTier;
  first_seen_at: number;
  last_seen_at: number;
  reputation_updated_at: number;
}

export type OutcomeKind = 'success' | 'refunded' | 'validator_violation';

const SILVER_MIN_SCORE = 0.5;
const GOLD_MIN_SCORE = 0.85;
const SILVER_MIN_FULFILLS = 5;
const GOLD_MIN_FULFILLS = 50;

/** Bayesian Beta posterior with Laplace smoothing (alpha = success + 1,
 *  beta = (refunded + violations) + 1). Returns the mean alpha/(alpha+beta).
 *  Always in [0, 1]. With zero observations the score is 0.5 (the prior). */
export function computeReputationScore(
  successful: number,
  refunded: number,
  violations: number,
): number {
  const alpha = successful + 1;
  const beta = refunded + violations + 1;
  return alpha / (alpha + beta);
}

/** Tier requires both a score AND a minimum-observation floor so a single
 *  successful fulfill doesn't immediately bump a fresh agent to gold. */
export function computeReputationTier(score: number, totalFulfills: number): ReputationTier {
  if (score >= GOLD_MIN_SCORE && totalFulfills >= GOLD_MIN_FULFILLS) return 'gold';
  if (score >= SILVER_MIN_SCORE && totalFulfills >= SILVER_MIN_FULFILLS) return 'silver';
  return 'bronze';
}

export class AgentReputationRepository {
  constructor(private db: Queryable) {}

  async findByPubkey(agentPubkey: string): Promise<AgentProfile | null> {
    const { rows } = await this.db.query<ProfileRow>(
      'SELECT * FROM fulfill_agent_profiles WHERE agent_pubkey = $1',
      [agentPubkey],
    );
    return rows[0] ? rowToProfile(rows[0]) : null;
  }

  /** Phase 11B.4 — slashing cron candidates : agents whose reputation is
   *  below the slash trigger AND who have enough observations for the
   *  signal to be meaningful AND who have been active recently (skip
   *  long-dormant agents). The slashing service does the bond + cool-down
   *  check itself ; this query just narrows the candidate set so the cron
   *  doesn't scan the whole table. Caller passes the trigger threshold
   *  + minimum-observation floor so this stays a pure data query. */
  async findCandidatesForSlashing(
    triggerScore: number,
    minObservations: number,
    sinceUpdatedAt: number,
    limit: number,
  ): Promise<string[]> {
    const { rows } = await this.db.query<{ agent_pubkey: string }>(
      `SELECT agent_pubkey FROM fulfill_agent_profiles
        WHERE reputation_score < $1
          AND total_fulfills >= $2
          AND reputation_updated_at >= $3
        ORDER BY reputation_score ASC, reputation_updated_at DESC
        LIMIT $4`,
      [triggerScore, minObservations, sinceUpdatedAt, limit],
    );
    return rows.map(r => r.agent_pubkey);
  }

  /** Create-or-update path. Reads the existing row (or treats a missing row
   *  as zeros), computes the new counters + score + tier in JS, and writes
   *  back atomically via UPSERT. Two concurrent recordOutcome calls on the
   *  same agent are serialised by the row's PRIMARY KEY constraint — the
   *  loser sees a constraint conflict and retries via the ON CONFLICT path,
   *  which then sees the freshly-updated counters. */
  async recordOutcome(
    agentPubkey: string,
    outcome: OutcomeKind,
    nowSec: number,
  ): Promise<AgentProfile> {
    // Read the current state (if any) for the score+tier computation.
    const existing = await this.findByPubkey(agentPubkey);
    const successDelta = outcome === 'success' ? 1 : 0;
    const refundDelta = outcome === 'refunded' ? 1 : 0;
    const violationDelta = outcome === 'validator_violation' ? 1 : 0;
    const total = (existing?.total_fulfills ?? 0) + 1;
    const successful = (existing?.successful_fulfills ?? 0) + successDelta;
    const refunded = (existing?.refunded_fulfills ?? 0) + refundDelta;
    const violations = (existing?.validator_violations ?? 0) + violationDelta;
    const score = computeReputationScore(successful, refunded, violations);
    const tier = computeReputationTier(score, total);
    const firstSeen = existing?.first_seen_at ?? nowSec;
    const { rows } = await this.db.query<ProfileRow>(
      `INSERT INTO fulfill_agent_profiles (
         agent_pubkey, total_fulfills,
         successful_fulfills, refunded_fulfills, validator_violations,
         reputation_score, reputation_tier,
         first_seen_at, last_seen_at, reputation_updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       ON CONFLICT (agent_pubkey) DO UPDATE
         SET total_fulfills = $2,
             successful_fulfills = $3,
             refunded_fulfills = $4,
             validator_violations = $5,
             reputation_score = $6,
             reputation_tier = $7,
             last_seen_at = $9,
             reputation_updated_at = $9
       RETURNING *`,
      [
        agentPubkey,
        total,
        successful,
        refunded,
        violations,
        score,
        tier,
        firstSeen,
        nowSec,
      ],
    );
    return rowToProfile(rows[0]);
  }
}

interface ProfileRow {
  agent_pubkey: string;
  total_fulfills: string | number;
  successful_fulfills: string | number;
  refunded_fulfills: string | number;
  validator_violations: string | number;
  reputation_score: string | number;
  reputation_tier: ReputationTier;
  first_seen_at: string | number;
  last_seen_at: string | number;
  reputation_updated_at: string | number;
}

function rowToProfile(r: ProfileRow): AgentProfile {
  return {
    agent_pubkey: r.agent_pubkey,
    total_fulfills: Number(r.total_fulfills),
    successful_fulfills: Number(r.successful_fulfills),
    refunded_fulfills: Number(r.refunded_fulfills),
    validator_violations: Number(r.validator_violations),
    reputation_score: Number(r.reputation_score),
    reputation_tier: r.reputation_tier,
    first_seen_at: Number(r.first_seen_at),
    last_seen_at: Number(r.last_seen_at),
    reputation_updated_at: Number(r.reputation_updated_at),
  };
}
