// Phase 11B.2 (2026-05-04) — Agent reputation service.
//
// Wraps the repository with a stable façade :
//   - recordFulfillOutcome (called from fulfillService at terminal status)
//   - getProfile / getProfileWithBondTier (read for /api/agent/:pubkey/reputation)
//   - effectiveTier(profile, available_bond_sats) — combines reputation_tier
//     with the bond size to produce the actual tier the rate-limiter and
//     credit-line use. A high-score agent without bond stays bronze ; a
//     bronze-score agent with bond ≥ 10000 still caps at silver.
//
// Per autonomy audit 2026-05-04 (lens L2). The score formula is Bayesian
// Beta with Laplace smoothing — see computeReputationScore + computeTier
// in the repository. This service adds the bond-floor + business rules
// and the audit-log coupling to fulfillService.
import { logger } from '../logger';
import {
  AgentReputationRepository,
  type AgentProfile,
  type OutcomeKind,
  type ReputationTier,
  computeReputationTier,
} from '../repositories/agentReputationRepository';

const SILVER_MIN_BOND_SATS = 1000;
const GOLD_MIN_BOND_SATS = 10000;

export interface AgentReputationServiceDeps {
  repo: AgentReputationRepository;
  now?: () => number;
}

export class AgentReputationService {
  private now: () => number;

  constructor(private readonly deps: AgentReputationServiceDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async getProfile(agentPubkey: string): Promise<AgentProfile | null> {
    return this.deps.repo.findByPubkey(agentPubkey);
  }

  async recordFulfillOutcome(agentPubkey: string, outcome: OutcomeKind): Promise<AgentProfile> {
    try {
      return await this.deps.repo.recordOutcome(agentPubkey, outcome, this.now());
    } catch (err) {
      // Reputation is observability/policy, never blocks the fulfill — log
      // the failure and return a synthetic neutral profile so callers don't
      // have to handle errors.
      logger.warn(
        { agent: agentPubkey.slice(0, 12), outcome, error: err instanceof Error ? err.message : String(err) },
        'AgentReputationService: recordOutcome failed (non-blocking)',
      );
      return {
        agent_pubkey: agentPubkey,
        total_fulfills: 0,
        successful_fulfills: 0,
        refunded_fulfills: 0,
        validator_violations: 0,
        reputation_score: 0.5,
        reputation_tier: 'bronze',
        first_seen_at: this.now(),
        last_seen_at: this.now(),
        reputation_updated_at: this.now(),
      };
    }
  }

  /** Combines reputation_tier with the bond floor. Same agent is bronze
   *  without bond, silver with bond ≥ 1000, gold with bond ≥ 10000 — but
   *  ONLY if their reputation_tier independently qualifies. A bronze
   *  reputation never reaches gold no matter the bond ; an unbonded gold
   *  reputation drops to silver. This makes the gate adversary-resistant :
   *  buying tier with sats alone is impossible, and burning a clean
   *  reputation by going unbonded is also impossible. */
  effectiveTier(profile: AgentProfile | null, availableBondSats: number): ReputationTier {
    const reputationTier: ReputationTier = profile?.reputation_tier ?? 'bronze';
    const bondTier: ReputationTier =
      availableBondSats >= GOLD_MIN_BOND_SATS ? 'gold'
      : availableBondSats >= SILVER_MIN_BOND_SATS ? 'silver'
      : 'bronze';
    // Effective is the MIN of the two ladders (bronze < silver < gold).
    const ladder: ReputationTier[] = ['bronze', 'silver', 'gold'];
    const idx = Math.min(ladder.indexOf(reputationTier), ladder.indexOf(bondTier));
    return ladder[idx];
  }

  /** Test-friendly recompute given counters + bond. Useful in unit tests. */
  effectiveTierFromCounters(
    successful: number,
    refunded: number,
    violations: number,
    availableBondSats: number,
  ): ReputationTier {
    const total = successful + refunded + violations;
    const score = (successful + 1) / (successful + refunded + violations + 2);
    const reputationTier = computeReputationTier(score, total);
    return this.effectiveTier(
      {
        agent_pubkey: '',
        total_fulfills: total,
        successful_fulfills: successful,
        refunded_fulfills: refunded,
        validator_violations: violations,
        reputation_score: score,
        reputation_tier: reputationTier,
        first_seen_at: 0,
        last_seen_at: 0,
        reputation_updated_at: 0,
      },
      availableBondSats,
    );
  }
}

export type { AgentProfile, ReputationTier, OutcomeKind } from '../repositories/agentReputationRepository';
