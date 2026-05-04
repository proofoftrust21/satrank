// Phase 11B.3 (2026-05-04) — AgentSlashingService tests.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { AgentReputationRepository } from '../repositories/agentReputationRepository';
import { AgentReputationService } from '../services/agentReputationService';
import { AgentBondRepository } from '../repositories/agentBondRepository';
import {
  AgentSlashingService,
  _resetSlashCooldownsForTests,
} from '../services/agentSlashingService';

let testDb: TestDb;
let pool: Pool;

const NOW = 1_700_000_000;
const PUBKEY = 'a'.repeat(64);

async function badAgent(repRepo: AgentReputationRepository, totalFulfills: number, refundCount: number): Promise<void> {
  const successCount = totalFulfills - refundCount;
  for (let i = 0; i < successCount; i += 1) await repRepo.recordOutcome(PUBKEY, 'success', NOW + i);
  for (let i = 0; i < refundCount; i += 1) await repRepo.recordOutcome(PUBKEY, 'refunded', NOW + 100 + i);
}

describe('Phase 11B.3 — AgentSlashingService.evaluateAndSlash', () => {
  let repRepo: AgentReputationRepository;
  let bondRepo: AgentBondRepository;
  let repService: AgentReputationService;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repRepo = new AgentReputationRepository(pool);
    bondRepo = new AgentBondRepository(pool);
    repService = new AgentReputationService({ repo: repRepo, now: () => NOW });
  });
  afterAll(async () => { await teardownTestPool(testDb); });
  beforeEach(async () => {
    await pool.query('TRUNCATE fulfill_agent_profiles, agent_bonds, agent_bond_pending_deposits RESTART IDENTITY CASCADE');
    _resetSlashCooldownsForTests();
  });

  it('no_action when no profile exists yet', async () => {
    const svc = new AgentSlashingService({ reputationService: repService, bondRepo, now: () => NOW });
    const out = await svc.evaluateAndSlash(PUBKEY);
    expect(out.status).toBe('no_action');
    if (out.status === 'no_action') expect(out.reason).toBe('no_profile');
  });

  it('no_action when total_fulfills below SLASH_MIN_OBSERVATIONS=10', async () => {
    await badAgent(repRepo, 5, 5);
    const svc = new AgentSlashingService({ reputationService: repService, bondRepo, now: () => NOW });
    const out = await svc.evaluateAndSlash(PUBKEY);
    expect(out.status).toBe('no_action');
    if (out.status === 'no_action') expect(out.reason).toBe('insufficient_observations');
  });

  it('no_action when score above trigger', async () => {
    await badAgent(repRepo, 20, 5); // 15 successes / 5 refunds → score ~0.76
    const svc = new AgentSlashingService({ reputationService: repService, bondRepo, now: () => NOW });
    const out = await svc.evaluateAndSlash(PUBKEY);
    expect(out.status).toBe('no_action');
    if (out.status === 'no_action') expect(out.reason).toBe('score_above_trigger');
  });

  it('no_action when no active bond exists', async () => {
    await badAgent(repRepo, 20, 20); // 0/20 → score ~0.045
    const svc = new AgentSlashingService({ reputationService: repService, bondRepo, now: () => NOW });
    const out = await svc.evaluateAndSlash(PUBKEY);
    expect(out.status).toBe('no_action');
    if (out.status === 'no_action') expect(out.reason).toBe('no_active_bond');
  });

  it('slashes when score < 0.1 + 10+ obs + bond present', async () => {
    await badAgent(repRepo, 20, 20);
    const bond = await bondRepo.create({
      agent_pubkey: PUBKEY,
      bond_payment_hash: 'a'.repeat(64),
      bond_committed_sats: 5000,
      releasable_at: NOW + 86400,
      created_at: NOW,
    });
    const credits: Array<{ sats: number; reason: string }> = [];
    const svc = new AgentSlashingService({
      reputationService: repService,
      bondRepo,
      creditPool: async (sats, reason) => { credits.push({ sats, reason }); },
      now: () => NOW,
    });
    const out = await svc.evaluateAndSlash(PUBKEY);
    expect(out.status).toBe('slashed');
    if (out.status === 'slashed') {
      expect(out.bond_id).toBe(bond.bond_id);
      // 10% of 5000 = 500, capped at SLASH_MAX_SATS_PER_TRIGGER=1000 → 500
      expect(out.sats).toBe(500);
    }
    const refreshed = await bondRepo.findById(bond.bond_id);
    expect(refreshed!.bond_slashed_sats).toBe(500);
    expect(refreshed!.bond_pending_sats).toBe(0);
    expect(credits).toHaveLength(1);
    expect(credits[0].sats).toBe(500);
  });

  it('caps slash at SLASH_MAX_SATS_PER_TRIGGER=1000 even on huge bonds', async () => {
    await badAgent(repRepo, 20, 20);
    await bondRepo.create({
      agent_pubkey: PUBKEY,
      bond_payment_hash: 'a'.repeat(64),
      bond_committed_sats: 1_000_000,
      releasable_at: NOW + 86400,
      created_at: NOW,
    });
    const svc = new AgentSlashingService({ reputationService: repService, bondRepo, now: () => NOW });
    const out = await svc.evaluateAndSlash(PUBKEY);
    expect(out.status).toBe('slashed');
    if (out.status === 'slashed') expect(out.sats).toBe(1000);
  });

  it('cool-down prevents double-slash within 24h', async () => {
    await badAgent(repRepo, 20, 20);
    await bondRepo.create({
      agent_pubkey: PUBKEY,
      bond_payment_hash: 'a'.repeat(64),
      bond_committed_sats: 5000,
      releasable_at: NOW + 86400,
      created_at: NOW,
    });
    const svc = new AgentSlashingService({ reputationService: repService, bondRepo, now: () => NOW });
    const first = await svc.evaluateAndSlash(PUBKEY);
    expect(first.status).toBe('slashed');
    const second = await svc.evaluateAndSlash(PUBKEY);
    expect(second.status).toBe('no_action');
    if (second.status === 'no_action') expect(second.reason).toBe('cooldown_active');
  });

  it('cooldown lifts after 24h', async () => {
    await badAgent(repRepo, 20, 20);
    await bondRepo.create({
      agent_pubkey: PUBKEY,
      bond_payment_hash: 'a'.repeat(64),
      bond_committed_sats: 5000,
      releasable_at: NOW + 86400,
      created_at: NOW,
    });
    let nowVal = NOW;
    const svc = new AgentSlashingService({ reputationService: repService, bondRepo, now: () => nowVal });
    const first = await svc.evaluateAndSlash(PUBKEY);
    expect(first.status).toBe('slashed');
    nowVal = NOW + 25 * 3600;
    const second = await svc.evaluateAndSlash(PUBKEY);
    expect(second.status).toBe('slashed'); // cooldown elapsed
  });

  it('runSlashingPass loops over candidates and aggregates outcomes', async () => {
    await badAgent(repRepo, 20, 20);
    await bondRepo.create({
      agent_pubkey: PUBKEY,
      bond_payment_hash: 'a'.repeat(64),
      bond_committed_sats: 5000,
      releasable_at: NOW + 86400,
      created_at: NOW,
    });
    const svc = new AgentSlashingService({ reputationService: repService, bondRepo, now: () => NOW });
    const outs = await svc.runSlashingPass([PUBKEY, 'b'.repeat(64)]);
    expect(outs).toHaveLength(2);
    expect(outs[0].status).toBe('slashed');
    expect(outs[1].status).toBe('no_action'); // unknown pubkey
  });
});
