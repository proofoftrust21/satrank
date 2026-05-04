// Phase 11B.2 (2026-05-04) — Agent reputation tests.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import {
  AgentReputationRepository,
  computeReputationScore,
  computeReputationTier,
} from '../repositories/agentReputationRepository';
import { AgentReputationService } from '../services/agentReputationService';

let testDb: TestDb;
let pool: Pool;

const NOW = 1_700_000_000;
const PUBKEY = 'a'.repeat(64);

describe('Phase 11B.2 — score / tier formulas', () => {
  it('Bayesian Beta with Laplace smoothing : zero observations → 0.5 (neutral prior)', () => {
    expect(computeReputationScore(0, 0, 0)).toBe(0.5);
  });

  it('all successes → asymptotically 1', () => {
    expect(computeReputationScore(100, 0, 0)).toBeCloseTo(101 / 102, 3);
    expect(computeReputationScore(1000, 0, 0)).toBeCloseTo(1001 / 1002, 3);
  });

  it('all failures → asymptotically 0', () => {
    expect(computeReputationScore(0, 100, 0)).toBeCloseTo(1 / 102, 3);
  });

  it('refunded and validator_violation both count as failures', () => {
    expect(computeReputationScore(10, 5, 0)).toBeCloseTo(11 / 17, 3);
    expect(computeReputationScore(10, 0, 5)).toBeCloseTo(11 / 17, 3);
    expect(computeReputationScore(10, 3, 2)).toBeCloseTo(11 / 17, 3);
  });

  it('tier requires both score AND minimum-observation floor', () => {
    expect(computeReputationTier(0.95, 0)).toBe('bronze');  // no obs
    expect(computeReputationTier(0.95, 4)).toBe('bronze');  // < 5 silver floor
    expect(computeReputationTier(0.7, 5)).toBe('silver');   // silver floor met
    expect(computeReputationTier(0.95, 49)).toBe('silver'); // < 50 gold floor
    expect(computeReputationTier(0.95, 50)).toBe('gold');   // gold met
    expect(computeReputationTier(0.49, 100)).toBe('bronze'); // score below floor
  });
});

describe('Phase 11B.2 — AgentReputationRepository.recordOutcome', () => {
  let repo: AgentReputationRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new AgentReputationRepository(pool);
  });
  afterAll(async () => { await teardownTestPool(testDb); });
  beforeEach(async () => {
    await pool.query('TRUNCATE fulfill_agent_profiles');
  });

  it('first success creates a row with total=1, successful=1', async () => {
    const profile = await repo.recordOutcome(PUBKEY, 'success', NOW);
    expect(profile.total_fulfills).toBe(1);
    expect(profile.successful_fulfills).toBe(1);
    expect(profile.refunded_fulfills).toBe(0);
    expect(profile.validator_violations).toBe(0);
    expect(profile.first_seen_at).toBe(NOW);
    expect(profile.last_seen_at).toBe(NOW);
    expect(profile.reputation_tier).toBe('bronze'); // total < 5
  });

  it('5 successes promote to silver', async () => {
    for (let i = 0; i < 5; i += 1) await repo.recordOutcome(PUBKEY, 'success', NOW + i);
    const profile = await repo.findByPubkey(PUBKEY);
    expect(profile!.successful_fulfills).toBe(5);
    expect(profile!.reputation_tier).toBe('silver');
  });

  it('50 successes promote to gold', async () => {
    for (let i = 0; i < 50; i += 1) await repo.recordOutcome(PUBKEY, 'success', NOW + i);
    const profile = await repo.findByPubkey(PUBKEY);
    expect(profile!.successful_fulfills).toBe(50);
    expect(profile!.reputation_tier).toBe('gold');
  });

  it('refunded outcomes count as failures and pull score down', async () => {
    for (let i = 0; i < 5; i += 1) await repo.recordOutcome(PUBKEY, 'success', NOW + i);
    const before = await repo.findByPubkey(PUBKEY);
    expect(before!.reputation_score).toBeGreaterThan(0.5);

    for (let i = 0; i < 10; i += 1) await repo.recordOutcome(PUBKEY, 'refunded', NOW + 100 + i);
    const after = await repo.findByPubkey(PUBKEY);
    expect(after!.refunded_fulfills).toBe(10);
    expect(after!.total_fulfills).toBe(15);
    expect(after!.reputation_score).toBeLessThan(before!.reputation_score);
    expect(after!.reputation_tier).toBe('bronze'); // 6/17 ~0.35 < 0.5
  });

  it('validator_violation counts as a failure too', async () => {
    await repo.recordOutcome(PUBKEY, 'validator_violation', NOW);
    const profile = await repo.findByPubkey(PUBKEY);
    expect(profile!.validator_violations).toBe(1);
    expect(profile!.refunded_fulfills).toBe(0);
    expect(profile!.successful_fulfills).toBe(0);
  });

  it('first_seen_at is preserved across updates', async () => {
    await repo.recordOutcome(PUBKEY, 'success', NOW);
    await repo.recordOutcome(PUBKEY, 'success', NOW + 1000);
    const profile = await repo.findByPubkey(PUBKEY);
    expect(profile!.first_seen_at).toBe(NOW);
    expect(profile!.last_seen_at).toBe(NOW + 1000);
  });
});

describe('Phase 11B.4 — findCandidatesForSlashing', () => {
  let repo: AgentReputationRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new AgentReputationRepository(pool);
  });
  afterAll(async () => { await teardownTestPool(testDb); });
  beforeEach(async () => {
    await pool.query('TRUNCATE fulfill_agent_profiles');
  });

  it('returns agents whose score is below trigger AND total >= floor AND profile updated since cutoff', async () => {
    const PUB_BAD = 'a'.repeat(64);
    const PUB_GOOD = 'b'.repeat(64);
    const PUB_THIN = 'c'.repeat(64);
    const PUB_DORMANT = 'd'.repeat(64);
    // Bad agent: 0/15 → score ~0.06, eligible
    for (let i = 0; i < 15; i += 1) await repo.recordOutcome(PUB_BAD, 'refunded', NOW + i);
    // Good agent: 15/15, score ~0.94, NOT eligible
    for (let i = 0; i < 15; i += 1) await repo.recordOutcome(PUB_GOOD, 'success', NOW + i);
    // Thin agent: 0/3 (score ~0.2 but below observation floor), NOT eligible
    for (let i = 0; i < 3; i += 1) await repo.recordOutcome(PUB_THIN, 'refunded', NOW + i);
    // Dormant agent: 0/15 but profile timestamp < cutoff, NOT eligible
    for (let i = 0; i < 15; i += 1) await repo.recordOutcome(PUB_DORMANT, 'refunded', NOW - 100 + i);

    const cutoff = NOW; // anything updated at or after NOW
    const candidates = await repo.findCandidatesForSlashing(0.1, 10, cutoff, 50);
    expect(candidates).toContain(PUB_BAD);
    expect(candidates).not.toContain(PUB_GOOD);
    expect(candidates).not.toContain(PUB_THIN);
    expect(candidates).not.toContain(PUB_DORMANT);
  });

  it('honours the limit', async () => {
    for (let agent = 0; agent < 5; agent += 1) {
      const pk = String.fromCharCode(0x41 + agent).repeat(64); // 'AAA…','BBB…' etc
      for (let i = 0; i < 15; i += 1) await repo.recordOutcome(pk, 'refunded', NOW + i);
    }
    const candidates = await repo.findCandidatesForSlashing(0.1, 10, 0, 3);
    expect(candidates).toHaveLength(3);
  });
});

describe('Phase 11B.2 — AgentReputationService.effectiveTier', () => {
  let repo: AgentReputationRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new AgentReputationRepository(pool);
  });
  afterAll(async () => { await teardownTestPool(testDb); });

  it('bronze reputation + bond ≥ gold threshold = silver (capped by reputation)', () => {
    const svc = new AgentReputationService({ repo, now: () => NOW });
    expect(svc.effectiveTierFromCounters(0, 100, 0, 50_000)).toBe('bronze');
  });

  it('gold reputation + no bond = bronze (capped by bond floor)', () => {
    const svc = new AgentReputationService({ repo, now: () => NOW });
    expect(svc.effectiveTierFromCounters(100, 0, 0, 0)).toBe('bronze');
  });

  it('gold reputation + silver bond = silver', () => {
    const svc = new AgentReputationService({ repo, now: () => NOW });
    expect(svc.effectiveTierFromCounters(100, 0, 0, 5_000)).toBe('silver');
  });

  it('gold reputation + gold bond = gold', () => {
    const svc = new AgentReputationService({ repo, now: () => NOW });
    expect(svc.effectiveTierFromCounters(100, 0, 0, 50_000)).toBe('gold');
  });

  it('null profile + bond gives bronze (no track record yet)', () => {
    const svc = new AgentReputationService({ repo, now: () => NOW });
    expect(svc.effectiveTier(null, 50_000)).toBe('bronze');
  });
});

describe('Phase 11B.2 — AgentReputationService.recordFulfillOutcome (non-blocking)', () => {
  let repo: AgentReputationRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new AgentReputationRepository(pool);
  });
  afterAll(async () => { await teardownTestPool(testDb); });
  beforeEach(async () => {
    await pool.query('TRUNCATE fulfill_agent_profiles');
  });

  it('returns the updated profile on success', async () => {
    const svc = new AgentReputationService({ repo, now: () => NOW });
    const profile = await svc.recordFulfillOutcome(PUBKEY, 'success');
    expect(profile.successful_fulfills).toBe(1);
  });

  it('returns a synthetic neutral profile on repository error (non-blocking)', async () => {
    const stubRepo = {
      async recordOutcome(): Promise<never> { throw new Error('db down'); },
      async findByPubkey() { return null; },
    } as unknown as AgentReputationRepository;
    const svc = new AgentReputationService({ repo: stubRepo, now: () => NOW });
    const profile = await svc.recordFulfillOutcome(PUBKEY, 'success');
    expect(profile.reputation_score).toBe(0.5);
    expect(profile.reputation_tier).toBe('bronze');
  });
});
