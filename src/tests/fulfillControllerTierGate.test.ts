// Phase 11B.5 (2026-05-04) — tier-aware rate-limit on FulfillController.
//
// Validates the bucket-params + cache behaviour without spinning up the
// full Express + LND + Postgres stack. The controller is instantiated
// with stub services that return canned (profile, bond) tuples so we
// drive resolveEffectiveTier deterministically.
import { describe, it, expect, beforeEach } from 'vitest';
import { FulfillController } from '../controllers/fulfillController';
import type { AgentReputationService, AgentProfile, ReputationTier } from '../services/agentReputationService';
import type { AgentBondService } from '../services/agentBondService';

interface StubReputationProvider {
  profile: AgentProfile | null;
  effectiveTier: ReputationTier;
}

function buildController(opts: {
  reputation: StubReputationProvider;
  bondAvailable: number;
}): FulfillController {
  const reputationService = {
    async getProfile(): Promise<AgentProfile | null> { return opts.reputation.profile; },
    async recordFulfillOutcome(): Promise<AgentProfile> { throw new Error('not used in this test'); },
    effectiveTier(): ReputationTier { return opts.reputation.effectiveTier; },
    effectiveTierFromCounters(): ReputationTier { return opts.reputation.effectiveTier; },
  } as unknown as AgentReputationService;
  const bondService = {
    async availableForAgent(): Promise<number> { return opts.bondAvailable; },
  } as unknown as AgentBondService;
  return new FulfillController({
    fulfillService: {} as never,
    enabled: true,
    rateBucketSize: 5,
    rateRefillPerSec: 0.5,
    reputationService,
    bondService,
  });
}

// Wrapper to access the private consumeRateToken via type assertion.
async function tryConsume(c: FulfillController, pk: string): Promise<boolean> {
  return await (c as unknown as { consumeRateToken: (pk: string) => Promise<boolean> }).consumeRateToken(pk);
}

describe('Phase 11B.5 — tier-aware rate-limit', () => {
  const PUBKEY = 'a'.repeat(64);

  it('bronze tier: bucket=1, refill=5/min — second call within seconds is denied', async () => {
    const ctl = buildController({
      reputation: { profile: null, effectiveTier: 'bronze' },
      bondAvailable: 0,
    });
    expect(await tryConsume(ctl, PUBKEY)).toBe(true);
    expect(await tryConsume(ctl, PUBKEY)).toBe(false); // bucket = 1 starts at 0 after first call
  });

  it('silver tier: bucket=5, default refill — 5 burst calls allowed, 6th denied', async () => {
    const ctl = buildController({
      reputation: {
        profile: {
          agent_pubkey: PUBKEY,
          total_fulfills: 20,
          successful_fulfills: 15,
          refunded_fulfills: 5,
          validator_violations: 0,
          reputation_score: 0.7,
          reputation_tier: 'silver',
          first_seen_at: 0,
          last_seen_at: 0,
          reputation_updated_at: 0,
        },
        effectiveTier: 'silver',
      },
      bondAvailable: 5_000,
    });
    for (let i = 0; i < 5; i += 1) {
      expect(await tryConsume(ctl, PUBKEY)).toBe(true);
    }
    expect(await tryConsume(ctl, PUBKEY)).toBe(false);
  });

  it('gold tier: bucket=30, refill=5/sec — 30 burst calls allowed', async () => {
    const ctl = buildController({
      reputation: {
        profile: {
          agent_pubkey: PUBKEY,
          total_fulfills: 100,
          successful_fulfills: 95,
          refunded_fulfills: 5,
          validator_violations: 0,
          reputation_score: 0.94,
          reputation_tier: 'gold',
          first_seen_at: 0,
          last_seen_at: 0,
          reputation_updated_at: 0,
        },
        effectiveTier: 'gold',
      },
      bondAvailable: 50_000,
    });
    for (let i = 0; i < 30; i += 1) {
      expect(await tryConsume(ctl, PUBKEY)).toBe(true);
    }
    expect(await tryConsume(ctl, PUBKEY)).toBe(false);
  });

  it('without reputationService dep, defaults to silver (back-compat)', async () => {
    // Pre-P11B.5 callers (existing tests, deployments that haven't wired
    // the tier deps yet) still get the silver bucket size from the env
    // overrides — same behaviour as before this commit.
    const ctl = new FulfillController({
      fulfillService: {} as never,
      enabled: true,
      rateBucketSize: 5,
      rateRefillPerSec: 0.5,
    });
    for (let i = 0; i < 5; i += 1) expect(await tryConsume(ctl, PUBKEY)).toBe(true);
    expect(await tryConsume(ctl, PUBKEY)).toBe(false);
  });
});
