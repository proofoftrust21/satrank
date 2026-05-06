// AEPS §6.3 — MultiHopChainService unit tests using an in-memory repository.
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  MultiHopChainService,
  computePreimageHash,
} from '../services/multiHopChainService';
import type {
  ChainState,
  CreateChainInput,
  CreateLegInput,
  LegState,
  MultiHopChain,
  MultiHopLeg,
  MultiHopChainRepository,
} from '../repositories/multiHopChainRepository';

class InMemoryRepo implements Pick<
  MultiHopChainRepository,
  'createChain' | 'createLegs' | 'findChain' | 'listLegs' | 'updateChainState' | 'updateLegState' | 'findExpiredActiveChains'
> {
  chains = new Map<string, MultiHopChain>();
  legs = new Map<string, MultiHopLeg[]>();
  legIdSeq = 0;

  async createChain(input: CreateChainInput): Promise<MultiHopChain> {
    const chain: MultiHopChain = {
      chain_id: input.chain_id,
      agent_pubkey: input.agent_pubkey,
      preimage_hash: input.preimage_hash,
      preimage_revealed: null,
      total_amount_msat: input.total_amount_msat,
      n_legs: input.n_legs,
      state: 'planning',
      created_at: input.created_at,
      expires_at: input.expires_at,
      settled_at: null,
      aborted_at: null,
      abort_reason: null,
    };
    this.chains.set(input.chain_id, chain);
    this.legs.set(input.chain_id, []);
    return chain;
  }

  async createLegs(legs: CreateLegInput[]): Promise<MultiHopLeg[]> {
    const out: MultiHopLeg[] = [];
    for (const l of legs) {
      this.legIdSeq += 1;
      const leg: MultiHopLeg = {
        leg_id: this.legIdSeq,
        chain_id: l.chain_id,
        leg_index: l.leg_index,
        endpoint_id: l.endpoint_id,
        operator_pubkey: l.operator_pubkey,
        amount_msat: l.amount_msat,
        request_body_sha256: l.request_body_sha256,
        state: 'planned',
        htlc_ref: null,
        fulfilled_response_sha256: null,
        locked_at: null,
        fulfilled_at: null,
        settled_at: null,
      };
      const existing = this.legs.get(l.chain_id) ?? [];
      existing.push(leg);
      this.legs.set(l.chain_id, existing);
      out.push(leg);
    }
    return out;
  }

  async findChain(chainId: string): Promise<MultiHopChain | null> {
    return this.chains.get(chainId) ?? null;
  }

  async listLegs(chainId: string): Promise<MultiHopLeg[]> {
    const ls = this.legs.get(chainId) ?? [];
    return [...ls].sort((a, b) => a.leg_index - b.leg_index);
  }

  async updateChainState(
    chainId: string,
    state: ChainState,
    extra: {
      preimage_revealed?: string;
      settled_at?: number;
      aborted_at?: number;
      abort_reason?: string;
    } = {},
  ): Promise<void> {
    const c = this.chains.get(chainId);
    if (!c) return;
    c.state = state;
    if (extra.preimage_revealed !== undefined) c.preimage_revealed = extra.preimage_revealed;
    if (extra.settled_at !== undefined) c.settled_at = extra.settled_at;
    if (extra.aborted_at !== undefined) c.aborted_at = extra.aborted_at;
    if (extra.abort_reason !== undefined) c.abort_reason = extra.abort_reason;
  }

  async updateLegState(
    chainId: string,
    legIndex: number,
    state: LegState,
    extra: {
      htlc_ref?: string;
      fulfilled_response_sha256?: string;
      locked_at?: number;
      fulfilled_at?: number;
      settled_at?: number;
    } = {},
  ): Promise<void> {
    const ls = this.legs.get(chainId);
    if (!ls) return;
    const leg = ls.find(l => l.leg_index === legIndex);
    if (!leg) return;
    leg.state = state;
    if (extra.htlc_ref !== undefined) leg.htlc_ref = extra.htlc_ref;
    if (extra.fulfilled_response_sha256 !== undefined) leg.fulfilled_response_sha256 = extra.fulfilled_response_sha256;
    if (extra.locked_at !== undefined) leg.locked_at = extra.locked_at;
    if (extra.fulfilled_at !== undefined) leg.fulfilled_at = extra.fulfilled_at;
    if (extra.settled_at !== undefined) leg.settled_at = extra.settled_at;
  }

  async findExpiredActiveChains(nowSec: number): Promise<MultiHopChain[]> {
    return Array.from(this.chains.values()).filter(
      c => ['planning', 'locked', 'settling'].includes(c.state) && c.expires_at < nowSec,
    );
  }
}

const AGENT_PUBKEY = 'a'.repeat(64);
const HASH = '11'.repeat(32);

function legSpec(i: number) {
  return {
    endpoint_id: `endpoint_${i}`,
    operator_pubkey: 'b'.repeat(64),
    amount_msat: 1000,
    request_body_sha256: HASH,
  };
}

function newSvc(now = 1_000_000): { svc: MultiHopChainService; repo: InMemoryRepo } {
  const repo = new InMemoryRepo();
  const svc = new MultiHopChainService({
    repo: repo as unknown as MultiHopChainRepository,
    now: () => now,
  });
  return { svc, repo };
}

describe('AEPS §6.3 — MultiHopChainService', () => {
  describe('planChain', () => {
    it('creates a chain and N legs in planned state', async () => {
      const { svc } = newSvc();
      const r = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0), legSpec(1), legSpec(2)],
      });
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      expect(r.chain.n_legs).toBe(3);
      expect(r.chain.total_amount_msat).toBe(3000);
      expect(r.chain.state).toBe('planning');
      expect(r.preimage_hex).toMatch(/^[0-9a-f]{64}$/);
      expect(computePreimageHash(r.preimage_hex)).toBe(r.chain.preimage_hash);
    });

    it('rejects fewer than 2 legs', async () => {
      const { svc } = newSvc();
      const r = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0)],
      });
      expect(r.status).toBe('invalid_input');
    });

    it('rejects more than 16 legs', async () => {
      const { svc } = newSvc();
      const legs = Array.from({ length: 17 }, (_, i) => legSpec(i));
      const r = await svc.planChain({ agent_pubkey: AGENT_PUBKEY, legs });
      expect(r.status).toBe('invalid_input');
    });

    it('rejects non-positive amount', async () => {
      const { svc } = newSvc();
      const r = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0), { ...legSpec(1), amount_msat: 0 }],
      });
      expect(r.status).toBe('invalid_input');
    });

    it('rejects malformed request_body_sha256', async () => {
      const { svc } = newSvc();
      const r = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [
          legSpec(0),
          { ...legSpec(1), request_body_sha256: 'too-short' },
        ],
      });
      expect(r.status).toBe('invalid_input');
    });

    it('uses default 600 sec TTL when ttl_sec omitted', async () => {
      const { svc } = newSvc(1_000_000);
      const r = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0), legSpec(1)],
      });
      if (r.status !== 'ok') throw new Error('plan failed');
      expect(r.chain.expires_at).toBe(1_000_000 + 600);
    });

    it('respects custom ttl_sec', async () => {
      const { svc } = newSvc(1_000_000);
      const r = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0), legSpec(1)],
        ttl_sec: 120,
      });
      if (r.status !== 'ok') throw new Error('plan failed');
      expect(r.chain.expires_at).toBe(1_000_000 + 120);
    });
  });

  describe('lockLeg', () => {
    it('locks a planned leg and stays planning until all locked', async () => {
      const { svc } = newSvc();
      const plan = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0), legSpec(1)],
      });
      if (plan.status !== 'ok') throw new Error('plan failed');
      const r = await svc.lockLeg(plan.chain.chain_id, 0, 'htlc_0');
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      expect(r.chain_state).toBe('planning');
    });

    it('transitions chain to locked when all legs locked', async () => {
      const { svc } = newSvc();
      const plan = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0), legSpec(1)],
      });
      if (plan.status !== 'ok') throw new Error('plan failed');
      await svc.lockLeg(plan.chain.chain_id, 0, 'htlc_0');
      const r = await svc.lockLeg(plan.chain.chain_id, 1, 'htlc_1');
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      expect(r.chain_state).toBe('locked');
    });

    it('returns chain_not_found for unknown chain', async () => {
      const { svc } = newSvc();
      const r = await svc.lockLeg('mhc_unknown', 0, 'htlc');
      expect(r.status).toBe('chain_not_found');
    });

    it('returns leg_not_found for invalid leg_index', async () => {
      const { svc } = newSvc();
      const plan = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0), legSpec(1)],
      });
      if (plan.status !== 'ok') throw new Error('plan failed');
      const r = await svc.lockLeg(plan.chain.chain_id, 5, 'htlc');
      expect(r.status).toBe('leg_not_found');
    });

    it('rejects locking the same leg twice', async () => {
      const { svc } = newSvc();
      const plan = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0), legSpec(1)],
      });
      if (plan.status !== 'ok') throw new Error('plan failed');
      await svc.lockLeg(plan.chain.chain_id, 0, 'htlc_0');
      const r = await svc.lockLeg(plan.chain.chain_id, 0, 'htlc_0_again');
      expect(r.status).toBe('invalid_state');
    });
  });

  describe('revealPreimage', () => {
    it('moves chain locked → settling on valid preimage', async () => {
      const { svc } = newSvc();
      const plan = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0), legSpec(1)],
      });
      if (plan.status !== 'ok') throw new Error('plan failed');
      await svc.lockLeg(plan.chain.chain_id, 0, 'htlc_0');
      await svc.lockLeg(plan.chain.chain_id, 1, 'htlc_1');
      const r = await svc.revealPreimage(plan.chain.chain_id, plan.preimage_hex);
      expect(r.status).toBe('ok');
    });

    it('rejects malformed preimage hex', async () => {
      const { svc } = newSvc();
      const plan = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0), legSpec(1)],
      });
      if (plan.status !== 'ok') throw new Error('plan failed');
      const r = await svc.revealPreimage(plan.chain.chain_id, 'short');
      expect(r.status).toBe('preimage_mismatch');
    });

    it('rejects mismatched preimage', async () => {
      const { svc } = newSvc();
      const plan = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0), legSpec(1)],
      });
      if (plan.status !== 'ok') throw new Error('plan failed');
      await svc.lockLeg(plan.chain.chain_id, 0, 'htlc_0');
      await svc.lockLeg(plan.chain.chain_id, 1, 'htlc_1');
      const r = await svc.revealPreimage(plan.chain.chain_id, '00'.repeat(32));
      expect(r.status).toBe('preimage_mismatch');
    });

    it('rejects reveal before all legs locked', async () => {
      const { svc } = newSvc();
      const plan = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0), legSpec(1)],
      });
      if (plan.status !== 'ok') throw new Error('plan failed');
      await svc.lockLeg(plan.chain.chain_id, 0, 'htlc_0');
      const r = await svc.revealPreimage(plan.chain.chain_id, plan.preimage_hex);
      expect(r.status).toBe('invalid_state');
    });
  });

  describe('settleLeg → complete', () => {
    it('walks all legs to settled and transitions chain to complete', async () => {
      const { svc } = newSvc();
      const plan = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0), legSpec(1), legSpec(2)],
      });
      if (plan.status !== 'ok') throw new Error('plan failed');
      const id = plan.chain.chain_id;
      await svc.lockLeg(id, 0, 'h0');
      await svc.lockLeg(id, 1, 'h1');
      await svc.lockLeg(id, 2, 'h2');
      await svc.revealPreimage(id, plan.preimage_hex);
      // Settle in reverse order (final → first).
      await svc.settleLeg(id, 2);
      await svc.settleLeg(id, 1);
      const r = await svc.settleLeg(id, 0);
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      expect(r.chain_state).toBe('complete');
    });

    it('rejects settling a non-locked leg', async () => {
      const { svc } = newSvc();
      const plan = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0), legSpec(1)],
      });
      if (plan.status !== 'ok') throw new Error('plan failed');
      const r = await svc.settleLeg(plan.chain.chain_id, 0);
      // Leg 0 is in 'planned', not 'locked' — and chain is in 'planning'.
      expect(r.status).toBe('invalid_state');
    });
  });

  describe('abortChain', () => {
    it('aborts a planning chain and marks all planned legs aborted', async () => {
      const { svc } = newSvc();
      const plan = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0), legSpec(1), legSpec(2)],
      });
      if (plan.status !== 'ok') throw new Error('plan failed');
      const r = await svc.abortChain(plan.chain.chain_id, 'test_reason');
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      expect(r.legs_aborted).toBe(3);
    });

    it('aborts a partially-locked chain (lock leg 0, abort)', async () => {
      const { svc } = newSvc();
      const plan = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0), legSpec(1)],
      });
      if (plan.status !== 'ok') throw new Error('plan failed');
      await svc.lockLeg(plan.chain.chain_id, 0, 'h0');
      const r = await svc.abortChain(plan.chain.chain_id, 'operator_2_failed');
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      expect(r.legs_aborted).toBe(2); // both planned-leg-1 and locked-leg-0
    });

    it('returns already_terminal for completed chain', async () => {
      const { svc } = newSvc();
      const plan = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0), legSpec(1)],
      });
      if (plan.status !== 'ok') throw new Error('plan failed');
      const id = plan.chain.chain_id;
      await svc.lockLeg(id, 0, 'h0');
      await svc.lockLeg(id, 1, 'h1');
      await svc.revealPreimage(id, plan.preimage_hex);
      await svc.settleLeg(id, 1);
      await svc.settleLeg(id, 0);
      const r = await svc.abortChain(id, 'whatever');
      expect(r.status).toBe('already_terminal');
    });

    it('returns chain_not_found for unknown chain', async () => {
      const { svc } = newSvc();
      const r = await svc.abortChain('mhc_unknown', 'test');
      expect(r.status).toBe('chain_not_found');
    });
  });

  describe('abortExpired', () => {
    it('aborts only chains past expires_at', async () => {
      let now = 1_000_000;
      const repo = new InMemoryRepo();
      const svc = new MultiHopChainService({
        repo: repo as unknown as MultiHopChainRepository,
        now: () => now,
      });
      const plan1 = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0), legSpec(1)],
        ttl_sec: 100,
      });
      const plan2 = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0), legSpec(1)],
        ttl_sec: 1000,
      });
      if (plan1.status !== 'ok' || plan2.status !== 'ok') throw new Error('plan');
      now = 1_000_500; // past plan1 expires_at, before plan2
      const aborted = await svc.abortExpired();
      expect(aborted).toBe(1);
      const c1 = await repo.findChain(plan1.chain.chain_id);
      const c2 = await repo.findChain(plan2.chain.chain_id);
      expect(c1?.state).toBe('aborted');
      expect(c2?.state).toBe('planning');
    });
  });

  describe('end-to-end happy path', () => {
    it('plan → lock × N → reveal → settle × N → complete', async () => {
      const { svc, repo } = newSvc();
      const plan = await svc.planChain({
        agent_pubkey: AGENT_PUBKEY,
        legs: [legSpec(0), legSpec(1), legSpec(2), legSpec(3)],
      });
      if (plan.status !== 'ok') throw new Error('plan failed');
      const id = plan.chain.chain_id;
      // Verify preimage hash matches
      const computed = createHash('sha256')
        .update(Buffer.from(plan.preimage_hex, 'hex'))
        .digest('hex');
      expect(computed).toBe(plan.chain.preimage_hash);
      // Lock all legs
      for (let i = 0; i < 4; i++) {
        await svc.lockLeg(id, i, `htlc_${i}`);
      }
      const lockedChain = await repo.findChain(id);
      expect(lockedChain?.state).toBe('locked');
      // Reveal preimage
      await svc.revealPreimage(id, plan.preimage_hex);
      const settlingChain = await repo.findChain(id);
      expect(settlingChain?.state).toBe('settling');
      expect(settlingChain?.preimage_revealed).toBe(plan.preimage_hex);
      // Cascade settle
      for (let i = 3; i >= 0; i--) {
        await svc.settleLeg(id, i);
      }
      const finalChain = await repo.findChain(id);
      expect(finalChain?.state).toBe('complete');
      expect(finalChain?.settled_at).toBeGreaterThan(0);
      const finalLegs = await repo.listLegs(id);
      expect(finalLegs.every(l => l.state === 'settled')).toBe(true);
    });
  });
});
