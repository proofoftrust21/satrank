// Phase 11B.2 (2026-05-04) — Agent reputation HTTP surface.
//
// GET /api/agent/:pubkey/reputation  (public, no auth)
//   Returns the agent's profile : counters, score, reputation_tier,
//   effective_tier (combining bond), first/last seen timestamps. Used by
//   counterparties (other agents, regulators, third-party verifiers) to
//   gauge an agent's track record. Public read because agent reputation
//   is the primary value-add of the ledger.
import type { Request, Response, NextFunction } from 'express';
import { sendError } from '../errors/errorEnvelope';
import type { AgentReputationService } from '../services/agentReputationService';
import type { AgentBondService } from './../services/agentBondService';

const PUBKEY_RE = /^[0-9a-f]{64,66}$/i;

export interface AgentReputationControllerDeps {
  service: AgentReputationService;
  bondService: AgentBondService;
}

export class AgentReputationController {
  constructor(private readonly deps: AgentReputationControllerDeps) {}

  show = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const pubkeyParam = req.params.pubkey;
      if (typeof pubkeyParam !== 'string' || !PUBKEY_RE.test(pubkeyParam)) {
        sendError(res, 'invalid_pubkey');
        return;
      }
      const [profile, availableBond] = await Promise.all([
        this.deps.service.getProfile(pubkeyParam),
        this.deps.bondService.availableForAgent(pubkeyParam),
      ]);
      const effective = this.deps.service.effectiveTier(profile, availableBond);
      // Synthesise a default response shape when the agent has never used
      // /api/fulfill — caller can still gauge tier from bond alone.
      if (!profile) {
        res.status(200).json({
          data: {
            agent_pubkey: pubkeyParam,
            total_fulfills: 0,
            successful_fulfills: 0,
            refunded_fulfills: 0,
            validator_violations: 0,
            reputation_score: 0.5,
            reputation_tier: 'bronze',
            available_bond_sats: availableBond,
            effective_tier: effective,
            first_seen_at: null,
            last_seen_at: null,
            reputation_updated_at: null,
          },
        });
        return;
      }
      res.status(200).json({
        data: {
          agent_pubkey: profile.agent_pubkey,
          total_fulfills: profile.total_fulfills,
          successful_fulfills: profile.successful_fulfills,
          refunded_fulfills: profile.refunded_fulfills,
          validator_violations: profile.validator_violations,
          reputation_score: Math.round(profile.reputation_score * 1000) / 1000,
          reputation_tier: profile.reputation_tier,
          available_bond_sats: availableBond,
          effective_tier: effective,
          first_seen_at: profile.first_seen_at,
          last_seen_at: profile.last_seen_at,
          reputation_updated_at: profile.reputation_updated_at,
        },
      });
    } catch (err) {
      next(err);
    }
  };
}
