// Phase 11B.5 (2026-05-04) — tier-gated credit-line cap on fulfillService.
//
// Bronze tier (no bond + low reputation) is refused at the gate ; the
// fulfill returns 'insufficient_balance' instead of borrowing. Silver and
// gold pass through to the existing reputation-credit ladder.
//
// We don't spin the full FulfillService stack here — testing the gate
// requires only the deps that participate in the borrow path : balance
// (token_balance row), agentCreditRepo, reputationService, bondService.
// Everything else is stubbed minimally.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { FulfillService } from '../services/fulfillService';
import { FulfillJobRepository } from '../repositories/fulfillJobRepository';
import { AgentCreditRepository } from '../repositories/agentCreditRepository';
import type { AgentReputationService, ReputationTier } from '../services/agentReputationService';
import type { AgentBondService } from '../services/agentBondService';
import type { IntentService } from '../services/intentService';

let testDb: TestDb;
let pool: Pool;

const NOW = 1_700_000_000;
const AGENT = 'a'.repeat(64);

function fakeIntent(): IntentService {
  return {
    async resolveIntent() { return { candidates: [] } as never; },
  } as unknown as IntentService;
}

function lndStub() {
  return { isAvailable: () => true } as never;
}

function buildService(deps: {
  reputation: ReputationTier;
  bondAvailable: number;
  agentCreditRepo: AgentCreditRepository;
}): FulfillService {
  const reputationService = {
    async getProfile() { return null; },
    effectiveTier(): ReputationTier { return deps.reputation; },
  } as unknown as AgentReputationService;
  const bondService = {
    async availableForAgent(): Promise<number> { return deps.bondAvailable; },
  } as unknown as AgentBondService;
  return new FulfillService({
    pool,
    fulfillJobRepo: new FulfillJobRepository(pool),
    intentService: fakeIntent(),
    lndClient: lndStub(),
    agentCreditRepo: deps.agentCreditRepo,
    reputationService,
    bondService,
    now: () => NOW,
  });
}

describe('Phase 11B.5 — credit-line tier gate', () => {
  let creditRepo: AgentCreditRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    creditRepo = new AgentCreditRepository(pool);
  });
  afterAll(async () => { await teardownTestPool(testDb); });
  beforeEach(async () => {
    await pool.query('TRUNCATE agent_credits, fulfill_jobs RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE token_balance RESTART IDENTITY CASCADE');
    // Agent has 0 sats — every fulfill request will hit the borrow path.
  });

  async function seedAccumulatedCredits(amount: number): Promise<void> {
    for (let i = 0; i < amount; i += 1) {
      await creditRepo.incrementOnSuccess(AGENT, NOW - i);
    }
  }

  it('bronze tier blocks borrow even with sufficient accumulated credits', async () => {
    await seedAccumulatedCredits(100);
    const svc = buildService({ reputation: 'bronze', bondAvailable: 0, agentCreditRepo: creditRepo });
    const result = await svc.fulfill({
      agent_pubkey: AGENT,
      intent: { category: 'data' },
      max_sats: 50,
      max_latency_ms: 5000,
    });
    expect(result.status).toBe('insufficient_balance');
    // Borrow did NOT happen — borrowed_sats stays at 0.
    const credits = await creditRepo.find(AGENT);
    expect(credits!.borrowed_sats).toBe(0);
  });

  it('silver tier passes through to existing borrow logic', async () => {
    await seedAccumulatedCredits(100);
    const svc = buildService({ reputation: 'silver', bondAvailable: 5_000, agentCreditRepo: creditRepo });
    const result = await svc.fulfill({
      agent_pubkey: AGENT,
      intent: { category: 'data' },
      max_sats: 50,
      max_latency_ms: 5000,
    });
    // Borrow succeeded → fulfill proceeded → no candidates → 'refunded'.
    // The borrow is then repaid (Audit C1) so borrowed_sats lands back at
    // 0 ; the reachability of 'refunded' is the gate-passed signal.
    expect(result.status).toBe('refunded');
  });

  it('gold tier passes through to existing borrow logic', async () => {
    await seedAccumulatedCredits(100);
    const svc = buildService({ reputation: 'gold', bondAvailable: 50_000, agentCreditRepo: creditRepo });
    const result = await svc.fulfill({
      agent_pubkey: AGENT,
      intent: { category: 'data' },
      max_sats: 50,
      max_latency_ms: 5000,
    });
    expect(result.status).toBe('refunded');
  });

  it('without reputationService dep, defaults to silver (back-compat)', async () => {
    await seedAccumulatedCredits(100);
    // Build service without reputation/bond deps — Phase 9.4 behaviour.
    const svc = new FulfillService({
      pool,
      fulfillJobRepo: new FulfillJobRepository(pool),
      intentService: fakeIntent(),
      lndClient: lndStub(),
      agentCreditRepo: creditRepo,
      now: () => NOW,
    });
    const result = await svc.fulfill({
      agent_pubkey: AGENT,
      intent: { category: 'data' },
      max_sats: 50,
      max_latency_ms: 5000,
    });
    expect(result.status).toBe('refunded');
  });
});
