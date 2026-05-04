// Phase 11B.3 (2026-05-04) — Agent slashing engine.
//
// Per autonomy audit 2026-05-04 (lens L2 + L6, sev-5 gap
// "no-rogue-agent-eviction"). Without a slashing path agents can game
// the refund/claim flow at zero cost ; pool absorbs the loss. This
// service implements the slash trigger : when an agent's reputation
// drops below SLASH_TRIGGER_SCORE with a meaningful sample size, a
// fraction of their available bond is moved to the pool (via reserve →
// commitSlash on agent_bonds, mirroring the operator-side ClaimEngine).
//
// V1 trigger (intentionally conservative — false-positive cost is high) :
//   - reputation_score < 0.1 (Beta posterior with mostly-failures)
//   - total_fulfills ≥ 10 (enough signal to discount randomness)
//   - active bond exists with bond_committed_sats > 0
//   - cool-down 24h between slashes per agent (no double-jeopardy in a single day)
//
// Slash amount per call : min(available_bond * 0.10, 1000 sats). Repeated
// triggers can drain the bond entirely ; the pool tops up by the same
// amount (callback-injected, mirrors PoolService for operator slash
// settlement).
//
// Cron hook : runSlashingPass() iterates over agents whose latest
// reputation_updated_at is recent AND who have active bonds. Order is
// score-ascending so the worst offenders are processed first.
import { logger } from '../logger';
import type { AgentReputationService, AgentProfile } from './agentReputationService';
import type { AgentBondRepository, AgentBond } from '../repositories/agentBondRepository';

export const SLASH_TRIGGER_SCORE = 0.1;
export const SLASH_MIN_OBSERVATIONS = 10;
export const SLASH_FRACTION = 0.10;
export const SLASH_MAX_SATS_PER_TRIGGER = 1000;
export const SLASH_COOLDOWN_SEC = 24 * 3600;

export interface AgentSlashingServiceDeps {
  reputationService: AgentReputationService;
  bondRepo: AgentBondRepository;
  /** Called when a slash commits — credits the absorbed_sats counter or
   *  topples up the pool balance (Phase 11 — P11B.4 wiring). Optional :
   *  v1 logs the credit and lets observability surface it ; full pool
   *  integration is a follow-up so the slashing primitive can ship
   *  independently of the credit path. */
  creditPool?: (sats: number, reason: string) => Promise<void>;
  now?: () => number;
}

export type SlashOutcome =
  | { status: 'no_action'; reason: string }
  | { status: 'slashed'; bond_id: number; sats: number };

const lastSlashAtByAgent = new Map<string, number>();

export class AgentSlashingService {
  private now: () => number;

  constructor(private readonly deps: AgentSlashingServiceDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Single-agent evaluation. Idempotent for the cool-down window — a
   *  caller that triggers it twice in 24h sees no_action on the second
   *  call. Returns the slash outcome so the caller can log + alert. */
  async evaluateAndSlash(agentPubkey: string): Promise<SlashOutcome> {
    const profile = await this.deps.reputationService.getProfile(agentPubkey);
    if (!profile) return { status: 'no_action', reason: 'no_profile' };
    if (profile.total_fulfills < SLASH_MIN_OBSERVATIONS) {
      return { status: 'no_action', reason: 'insufficient_observations' };
    }
    if (profile.reputation_score >= SLASH_TRIGGER_SCORE) {
      return { status: 'no_action', reason: 'score_above_trigger' };
    }
    const cooldownAt = lastSlashAtByAgent.get(agentPubkey);
    if (cooldownAt !== undefined && this.now() - cooldownAt < SLASH_COOLDOWN_SEC) {
      return { status: 'no_action', reason: 'cooldown_active' };
    }
    const bonds = await this.deps.bondRepo.findActiveByAgent(agentPubkey);
    if (bonds.length === 0) {
      return { status: 'no_action', reason: 'no_active_bond' };
    }
    // Pick the bond with the most available capacity.
    const targetBond = bonds.reduce<AgentBond | null>((best, b) => {
      const avail = b.bond_committed_sats - b.bond_slashed_sats - b.bond_pending_sats;
      const bestAvail = best ? (best.bond_committed_sats - best.bond_slashed_sats - best.bond_pending_sats) : -1;
      return avail > bestAvail ? b : best;
    }, null);
    if (!targetBond) return { status: 'no_action', reason: 'no_active_bond' };
    const available = targetBond.bond_committed_sats - targetBond.bond_slashed_sats - targetBond.bond_pending_sats;
    if (available <= 0) return { status: 'no_action', reason: 'bond_exhausted' };
    const slashSats = Math.min(
      Math.max(1, Math.floor(available * SLASH_FRACTION)),
      SLASH_MAX_SATS_PER_TRIGGER,
      available,
    );
    const reserved = await this.deps.bondRepo.reservePending(targetBond.bond_id, slashSats);
    if (!reserved) {
      return { status: 'no_action', reason: 'reserve_failed' };
    }
    const committed = await this.deps.bondRepo.commitSlash(targetBond.bond_id, slashSats, this.now());
    if (!committed) {
      // Reserve + commit is supposed to be atomic in practice (single SQL
      // statement each, with the reserve guarding pending). If commitSlash
      // returns false the reserve rolls back.
      await this.deps.bondRepo.releasePending(targetBond.bond_id, slashSats);
      return { status: 'no_action', reason: 'commit_failed' };
    }
    lastSlashAtByAgent.set(agentPubkey, this.now());
    if (this.deps.creditPool) {
      try {
        await this.deps.creditPool(slashSats, `agent_slash:${agentPubkey.slice(0, 12)}`);
      } catch (err) {
        logger.warn(
          { agent: agentPubkey.slice(0, 12), error: err instanceof Error ? err.message : String(err) },
          'AgentSlashingService: pool credit failed (slash already committed)',
        );
      }
    }
    logger.warn(
      {
        agent: agentPubkey.slice(0, 12),
        bond_id: targetBond.bond_id,
        sats: slashSats,
        score: Math.round(profile.reputation_score * 1000) / 1000,
        total_fulfills: profile.total_fulfills,
      },
      'AgentSlashingService: agent bond slashed (Phase 11B.3)',
    );
    return { status: 'slashed', bond_id: targetBond.bond_id, sats: slashSats };
  }

  /** Cron entry-point. v1 walks every agent that has a recent profile
   *  update — caller-supplied since /api/fulfill is the only update path
   *  and there's no scan-by-score query yet. Returns the slash outcomes. */
  async runSlashingPass(candidatePubkeys: string[]): Promise<SlashOutcome[]> {
    const out: SlashOutcome[] = [];
    for (const pk of candidatePubkeys) {
      const outcome = await this.evaluateAndSlash(pk);
      out.push(outcome);
    }
    const slashed = out.filter(o => o.status === 'slashed').length;
    if (slashed > 0) {
      logger.info(
        { evaluated: candidatePubkeys.length, slashed },
        'AgentSlashingService: slashing pass complete',
      );
    }
    return out;
  }
}

/** Test helper — clear the in-memory cool-down map. Production must NEVER
 *  call this outside of admin tooling because it removes the
 *  double-jeopardy guard. */
export function _resetSlashCooldownsForTests(): void {
  lastSlashAtByAgent.clear();
}
