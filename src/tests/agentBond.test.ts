// Phase 11B.1 (2026-05-04) — Agent bond repository + service tests.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { AgentBondRepository } from '../repositories/agentBondRepository';
import { AgentBondService } from '../services/agentBondService';

let testDb: TestDb;
let pool: Pool;

const NOW = 1_700_000_000;
const PUBKEY = 'a'.repeat(64);

// Test stubs that satisfy only the subset of LndHoldInvoiceService that
// AgentBondService actually calls (isAvailable + addHoldInvoice). Cast via
// `unknown` because the real class has private internals (restUrl, doFetch,
// etc.) we don't reproduce here — the caller never reads those.
const holdInvoiceServiceStub = {
  isAvailable() { return true; },
  async addHoldInvoice(req: { valueSat: number; memo?: string; expirySec: number }): Promise<{ payment_request: string; payment_hash: string; preimage: string }> {
    return {
      payment_request: `lnbc${req.valueSat}n1pStub`,
      payment_hash: `${'h'.repeat(60)}${req.valueSat.toString(16).padStart(4, '0')}`,
      preimage: 'p'.repeat(64),
    };
  },
} as unknown as ConstructorParameters<typeof AgentBondService>[0]['holdInvoiceService'];

const lndUnavailableStub = {
  isAvailable() { return false; },
  async addHoldInvoice(): Promise<{ payment_request: string; payment_hash: string; preimage: string }> {
    throw new Error('not used');
  },
} as unknown as ConstructorParameters<typeof AgentBondService>[0]['holdInvoiceService'];

describe('Phase 11B.1 — AgentBondRepository round-trip', () => {
  let repo: AgentBondRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new AgentBondRepository(pool);
  });
  afterAll(async () => { await teardownTestPool(testDb); });
  beforeEach(async () => {
    await pool.query('TRUNCATE agent_bonds, agent_bond_pending_deposits RESTART IDENTITY CASCADE');
  });

  it('create + findById round-trip', async () => {
    const bond = await repo.create({
      agent_pubkey: PUBKEY,
      bond_payment_hash: 'a'.repeat(64),
      bond_committed_sats: 5000,
      releasable_at: NOW + 14 * 86400,
      created_at: NOW,
    });
    expect(bond.bond_id).toBeGreaterThan(0);
    expect(bond.state).toBe('active');
    expect(bond.bond_committed_sats).toBe(5000);
    expect(bond.bond_slashed_sats).toBe(0);
    expect(bond.bond_pending_sats).toBe(0);
    expect(bond.min_floor_sats).toBe(100);
    const fetched = await repo.findById(bond.bond_id);
    expect(fetched).toEqual(bond);
  });

  it('availableForAgent sums committed - slashed - pending across bonds', async () => {
    await repo.create({
      agent_pubkey: PUBKEY,
      bond_payment_hash: 'a'.repeat(64),
      bond_committed_sats: 1000,
      releasable_at: NOW + 86400,
      created_at: NOW,
    });
    await repo.create({
      agent_pubkey: PUBKEY,
      bond_payment_hash: 'b'.repeat(64),
      bond_committed_sats: 5000,
      releasable_at: NOW + 86400,
      created_at: NOW,
    });
    expect(await repo.availableForAgent(PUBKEY)).toBe(6000);
  });

  it('reservePending fails when overdrawn, succeeds when within limit', async () => {
    const bond = await repo.create({
      agent_pubkey: PUBKEY,
      bond_payment_hash: 'a'.repeat(64),
      bond_committed_sats: 1000,
      releasable_at: NOW + 86400,
      created_at: NOW,
    });
    expect(await repo.reservePending(bond.bond_id, 500)).toBe(true);
    expect(await repo.reservePending(bond.bond_id, 600)).toBe(false); // would overdraw
    expect(await repo.reservePending(bond.bond_id, 500)).toBe(true);
    const fetched = await repo.findById(bond.bond_id);
    expect(fetched!.bond_pending_sats).toBe(1000);
  });

  it('commitSlash converts pending → slashed and stamps slashed_total_at on full slash', async () => {
    const bond = await repo.create({
      agent_pubkey: PUBKEY,
      bond_payment_hash: 'a'.repeat(64),
      bond_committed_sats: 1000,
      releasable_at: NOW + 86400,
      created_at: NOW,
    });
    await repo.reservePending(bond.bond_id, 1000);
    const ok = await repo.commitSlash(bond.bond_id, 1000, NOW + 100);
    expect(ok).toBe(true);
    const fetched = await repo.findById(bond.bond_id);
    expect(fetched!.bond_slashed_sats).toBe(1000);
    expect(fetched!.bond_pending_sats).toBe(0);
    expect(fetched!.slashed_total_at).toBe(NOW + 100);
  });

  it('setState rejects illegal transitions (released is terminal)', async () => {
    const bond = await repo.create({
      agent_pubkey: PUBKEY,
      bond_payment_hash: 'a'.repeat(64),
      bond_committed_sats: 1000,
      releasable_at: NOW + 86400,
      created_at: NOW,
    });
    expect(await repo.setState(bond.bond_id, 'released')).toBe(true);
    expect(await repo.setState(bond.bond_id, 'frozen')).toBe(false);
    expect(await repo.setState(bond.bond_id, 'active')).toBe(false);
  });

  it('findBelowFloor returns bonds whose available < min_floor', async () => {
    const bond = await repo.create({
      agent_pubkey: PUBKEY,
      bond_payment_hash: 'a'.repeat(64),
      bond_committed_sats: 1000,
      releasable_at: NOW + 86400,
      created_at: NOW,
      min_floor_sats: 500,
    });
    expect((await repo.findBelowFloor()).length).toBe(0);
    await repo.reservePending(bond.bond_id, 600);
    const below = await repo.findBelowFloor();
    expect(below.length).toBe(1);
    expect(below[0].bond_id).toBe(bond.bond_id);
  });

  it('findReleasable picks active bonds with no pending past releasable_at', async () => {
    const old = await repo.create({
      agent_pubkey: PUBKEY,
      bond_payment_hash: 'a'.repeat(64),
      bond_committed_sats: 1000,
      releasable_at: NOW - 10,
      created_at: NOW - 100,
    });
    await repo.create({
      agent_pubkey: PUBKEY,
      bond_payment_hash: 'b'.repeat(64),
      bond_committed_sats: 1000,
      releasable_at: NOW + 86400,
      created_at: NOW,
    });
    const releasable = await repo.findReleasable(NOW);
    expect(releasable).toHaveLength(1);
    expect(releasable[0].bond_id).toBe(old.bond_id);
  });

  it('pending deposit lifecycle : create → settle', async () => {
    const pending = await repo.createPendingDeposit({
      agent_pubkey: PUBKEY,
      payment_hash: 'p'.repeat(64),
      payment_request: 'lnbc1nStub',
      amount_sats: 1000,
      created_at: NOW,
      expires_at: NOW + 3600,
    });
    expect(pending.settled_at).toBeNull();
    const found = await repo.findPendingByPaymentHash('p'.repeat(64));
    expect(found?.pending_id).toBe(pending.pending_id);
    const settled = await repo.settlePendingDeposit('p'.repeat(64), NOW + 60);
    expect(settled).toBe(true);
    const refound = await repo.findPendingByPaymentHash('p'.repeat(64));
    expect(refound!.settled_at).toBe(NOW + 60);
  });
});

describe('Phase 11B.1 — AgentBondService.createDeposit', () => {
  let repo: AgentBondRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new AgentBondRepository(pool);
  });
  afterAll(async () => { await teardownTestPool(testDb); });
  beforeEach(async () => {
    await pool.query('TRUNCATE agent_bonds, agent_bond_pending_deposits RESTART IDENTITY CASCADE');
  });

  it('happy path : invoice issued + bond row created LOCKED + pending deposit row', async () => {
    const svc = new AgentBondService({
      bondRepo: repo,
      holdInvoiceService: holdInvoiceServiceStub,
      now: () => NOW,
    });
    const result = await svc.createDeposit({ agent_pubkey: PUBKEY, bond_sats: 5000 });
    expect(result.status).toBe('invoice_issued');
    if (result.status !== 'invoice_issued') return;
    expect(result.bond_id).toBeGreaterThan(0);
    expect(result.payment_request).toMatch(/^lnbc/);
    const bond = await repo.findById(result.bond_id);
    expect(bond!.bond_committed_sats).toBe(5000);
    // Phase 11B.6 — bond is locked (pending = committed) until settlement.
    expect(bond!.bond_pending_sats).toBe(5000);
    expect(await repo.availableForAgent(PUBKEY)).toBe(0);
    expect(bond!.releasable_at).toBe(NOW + 14 * 86400);
    // Pending deposit row contains the preimage the watcher needs.
    const pending = await repo.findPendingByPaymentHash(result.payment_hash);
    expect(pending).toBeTruthy();
    expect(pending!.preimage_hex).toBe('p'.repeat(64));
    expect(pending!.amount_sats).toBe(5000);
  });

  it('rejects bond_sats below MIN_BOND_SATS=1000', async () => {
    const svc = new AgentBondService({
      bondRepo: repo,
      holdInvoiceService: holdInvoiceServiceStub,
      now: () => NOW,
    });
    const result = await svc.createDeposit({ agent_pubkey: PUBKEY, bond_sats: 500 });
    expect(result.status).toBe('invalid_request');
  });

  it('rejects bond_sats above MAX_BOND_SATS', async () => {
    const svc = new AgentBondService({
      bondRepo: repo,
      holdInvoiceService: holdInvoiceServiceStub,
      now: () => NOW,
    });
    const result = await svc.createDeposit({ agent_pubkey: PUBKEY, bond_sats: 100_000_000 });
    expect(result.status).toBe('invalid_request');
  });

  it('rejects min_floor_sats > bond_sats / 2', async () => {
    const svc = new AgentBondService({
      bondRepo: repo,
      holdInvoiceService: holdInvoiceServiceStub,
      now: () => NOW,
    });
    const result = await svc.createDeposit({ agent_pubkey: PUBKEY, bond_sats: 2000, min_floor_sats: 1500 });
    expect(result.status).toBe('invalid_request');
  });

  it('rejects cooldown_sec outside [1d, 90d]', async () => {
    const svc = new AgentBondService({
      bondRepo: repo,
      holdInvoiceService: holdInvoiceServiceStub,
      now: () => NOW,
    });
    expect((await svc.createDeposit({ agent_pubkey: PUBKEY, bond_sats: 5000, cooldown_sec: 3600 })).status).toBe('invalid_request');
    expect((await svc.createDeposit({ agent_pubkey: PUBKEY, bond_sats: 5000, cooldown_sec: 91 * 86400 })).status).toBe('invalid_request');
  });

  it('returns lnd_unavailable when holdInvoiceService is missing or down', async () => {
    const noLnd = new AgentBondService({ bondRepo: repo, now: () => NOW });
    expect((await noLnd.createDeposit({ agent_pubkey: PUBKEY, bond_sats: 5000 })).status).toBe('lnd_unavailable');
    const downLnd = new AgentBondService({ bondRepo: repo, holdInvoiceService: lndUnavailableStub, now: () => NOW });
    expect((await downLnd.createDeposit({ agent_pubkey: PUBKEY, bond_sats: 5000 })).status).toBe('lnd_unavailable');
  });
});

describe('Phase 11B.6 — AgentBondService.runSettlementCycle', () => {
  let repo: AgentBondRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new AgentBondRepository(pool);
  });
  afterAll(async () => { await teardownTestPool(testDb); });
  beforeEach(async () => {
    await pool.query('TRUNCATE agent_bonds, agent_bond_pending_deposits RESTART IDENTITY CASCADE');
  });

  function makeLndStub(opts: {
    states?: Record<string, 'OPEN' | 'ACCEPTED' | 'SETTLED' | 'CANCELED' | 'EXPIRED' | 'UNKNOWN'>;
    settleThrows?: Error;
  } = {}) {
    const settled: string[] = [];
    const canceled: string[] = [];
    return {
      settled,
      canceled,
      stub: {
        isAvailable() { return true; },
        async addHoldInvoice() { throw new Error('not used'); },
        async lookupState(hash: string) { return { state: opts.states?.[hash] ?? 'OPEN', amt_paid_sat: 0 }; },
        async settle(preimage: string) {
          if (opts.settleThrows) throw opts.settleThrows;
          settled.push(preimage);
        },
        async cancel(hash: string) { canceled.push(hash); },
      } as unknown as ConstructorParameters<typeof AgentBondService>[0]['holdInvoiceService'],
    };
  }

  async function seedDeposit(amount: number = 5000, paymentHashHex: string = 'h'.repeat(64)) {
    const svc = new AgentBondService({
      bondRepo: repo,
      holdInvoiceService: {
        isAvailable() { return true; },
        async addHoldInvoice() {
          return { payment_request: 'lnbc1nStub', payment_hash: paymentHashHex, preimage: 'p'.repeat(64) };
        },
      } as unknown as ConstructorParameters<typeof AgentBondService>[0]['holdInvoiceService'],
      now: () => NOW,
    });
    const r = await svc.createDeposit({ agent_pubkey: PUBKEY, bond_sats: amount });
    if (r.status !== 'invoice_issued') throw new Error('seed failed');
    return r;
  }

  it('ACCEPTED → settle preimage + unlock bond_pending_sats', async () => {
    const dep = await seedDeposit();
    const lnd = makeLndStub({ states: { [dep.payment_hash]: 'ACCEPTED' } });
    const svc = new AgentBondService({
      bondRepo: repo,
      holdInvoiceService: lnd.stub,
      now: () => NOW + 60,
    });
    const out = await svc.runSettlementCycle();
    expect(out.unlocked).toBe(1);
    expect(lnd.settled).toEqual(['p'.repeat(64)]);
    expect(await repo.availableForAgent(PUBKEY)).toBe(5000);
    const pending = await repo.findPendingByPaymentHash(dep.payment_hash);
    expect(pending!.settled_at).toBe(NOW + 60);
  });

  it('CANCELED → bond stays locked, pending marked failed', async () => {
    const dep = await seedDeposit();
    const lnd = makeLndStub({ states: { [dep.payment_hash]: 'CANCELED' } });
    const svc = new AgentBondService({
      bondRepo: repo,
      holdInvoiceService: lnd.stub,
      now: () => NOW + 60,
    });
    const out = await svc.runSettlementCycle();
    expect(out.failed).toBe(1);
    expect(lnd.settled).toEqual([]);
    expect(await repo.availableForAgent(PUBKEY)).toBe(0); // still locked
    const pending = await repo.findPendingByPaymentHash(dep.payment_hash);
    expect(pending!.settled_at).toBe(NOW + 60);
  });

  it('EXPIRED → bond stays locked, pending settled', async () => {
    const dep = await seedDeposit();
    const lnd = makeLndStub({ states: { [dep.payment_hash]: 'EXPIRED' } });
    const svc = new AgentBondService({
      bondRepo: repo,
      holdInvoiceService: lnd.stub,
      now: () => NOW + 60,
    });
    const out = await svc.runSettlementCycle();
    expect(out.failed).toBe(1);
    expect(await repo.availableForAgent(PUBKEY)).toBe(0);
  });

  it('OPEN past expires_at → cancel on LND, mark failed', async () => {
    const dep = await seedDeposit();
    const lnd = makeLndStub({ states: { [dep.payment_hash]: 'OPEN' } });
    const svc = new AgentBondService({
      bondRepo: repo,
      holdInvoiceService: lnd.stub,
      now: () => NOW + 7200, // past 1h expiry
    });
    const out = await svc.runSettlementCycle();
    expect(out.failed).toBe(1);
    expect(lnd.canceled).toEqual([dep.payment_hash]);
    expect(await repo.availableForAgent(PUBKEY)).toBe(0);
  });

  it('OPEN before expires_at → skipped, retry next tick', async () => {
    const dep = await seedDeposit();
    const lnd = makeLndStub({ states: { [dep.payment_hash]: 'OPEN' } });
    const svc = new AgentBondService({
      bondRepo: repo,
      holdInvoiceService: lnd.stub,
      now: () => NOW + 60, // well within 1h expiry
    });
    const out = await svc.runSettlementCycle();
    expect(out.skipped).toBe(1);
    const pending = await repo.findPendingByPaymentHash(dep.payment_hash);
    expect(pending!.settled_at).toBeNull(); // not yet
  });

  it('settle throws InvoiceAlreadyCanceled → mark failed', async () => {
    const dep = await seedDeposit();
    const { InvoiceAlreadyCanceledError } = await import('../services/lndHoldInvoiceService');
    const lnd = makeLndStub({
      states: { [dep.payment_hash]: 'ACCEPTED' },
      settleThrows: new InvoiceAlreadyCanceledError('p'.repeat(8)),
    });
    const svc = new AgentBondService({
      bondRepo: repo,
      holdInvoiceService: lnd.stub,
      now: () => NOW + 60,
    });
    const out = await svc.runSettlementCycle();
    expect(out.failed).toBe(1);
    expect(await repo.availableForAgent(PUBKEY)).toBe(0);
  });

  it('settle throws other error → skipped (retry next tick)', async () => {
    const dep = await seedDeposit();
    const lnd = makeLndStub({
      states: { [dep.payment_hash]: 'ACCEPTED' },
      settleThrows: new Error('lnd transient'),
    });
    const svc = new AgentBondService({
      bondRepo: repo,
      holdInvoiceService: lnd.stub,
      now: () => NOW + 60,
    });
    const out = await svc.runSettlementCycle();
    expect(out.skipped).toBe(1);
    const pending = await repo.findPendingByPaymentHash(dep.payment_hash);
    expect(pending!.settled_at).toBeNull(); // retry
  });

  it('SETTLED out-of-band → unlocks (defensive)', async () => {
    const dep = await seedDeposit();
    const lnd = makeLndStub({ states: { [dep.payment_hash]: 'SETTLED' } });
    const svc = new AgentBondService({
      bondRepo: repo,
      holdInvoiceService: lnd.stub,
      now: () => NOW + 60,
    });
    const out = await svc.runSettlementCycle();
    expect(out.unlocked).toBe(1);
    expect(await repo.availableForAgent(PUBKEY)).toBe(5000);
  });

  it('runSettlementCycle handles multiple deposits in one tick', async () => {
    await seedDeposit(1000, 'a'.repeat(64));
    await seedDeposit(2000, 'b'.repeat(64));
    const lnd = makeLndStub({
      states: {
        ['a'.repeat(64)]: 'ACCEPTED',
        ['b'.repeat(64)]: 'CANCELED',
      },
    });
    const svc = new AgentBondService({
      bondRepo: repo,
      holdInvoiceService: lnd.stub,
      now: () => NOW + 60,
    });
    const out = await svc.runSettlementCycle();
    expect(out.unlocked).toBe(1);
    expect(out.failed).toBe(1);
  });

  it('without LND service available, no-op (returns 0/0/0)', async () => {
    await seedDeposit();
    const svc = new AgentBondService({
      bondRepo: repo,
      holdInvoiceService: undefined,
      now: () => NOW + 60,
    });
    const out = await svc.runSettlementCycle();
    expect(out).toEqual({ unlocked: 0, failed: 0, skipped: 0 });
  });
});

describe('Phase 11B.1 — AgentBondService.freeze + queries', () => {
  let repo: AgentBondRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new AgentBondRepository(pool);
  });
  afterAll(async () => { await teardownTestPool(testDb); });
  beforeEach(async () => {
    await pool.query('TRUNCATE agent_bonds, agent_bond_pending_deposits RESTART IDENTITY CASCADE');
  });

  it('freeze : owner-only', async () => {
    const svc = new AgentBondService({ bondRepo: repo, now: () => NOW });
    const bond = await repo.create({
      agent_pubkey: PUBKEY,
      bond_payment_hash: 'a'.repeat(64),
      bond_committed_sats: 1000,
      releasable_at: NOW + 86400,
      created_at: NOW,
    });
    expect(await svc.freeze(bond.bond_id, 'd'.repeat(64))).toBe(false); // wrong owner
    expect(await svc.freeze(bond.bond_id, PUBKEY)).toBe(true);
    expect(await svc.freeze(bond.bond_id, PUBKEY)).toBe(false); // already frozen
  });

  it('availableForAgent + listForAgent surface bond state to controllers', async () => {
    const svc = new AgentBondService({ bondRepo: repo, now: () => NOW });
    await repo.create({
      agent_pubkey: PUBKEY,
      bond_payment_hash: 'a'.repeat(64),
      bond_committed_sats: 5000,
      releasable_at: NOW + 86400,
      created_at: NOW,
    });
    expect(await svc.availableForAgent(PUBKEY)).toBe(5000);
    const bonds = await svc.listForAgent(PUBKEY);
    expect(bonds).toHaveLength(1);
    expect(bonds[0].bond_committed_sats).toBe(5000);
  });

  it('findUnderfundedAgents flags agents below floor', async () => {
    const svc = new AgentBondService({ bondRepo: repo, now: () => NOW });
    const bond = await repo.create({
      agent_pubkey: PUBKEY,
      bond_payment_hash: 'a'.repeat(64),
      bond_committed_sats: 1000,
      releasable_at: NOW + 86400,
      created_at: NOW,
      min_floor_sats: 500,
    });
    expect(await svc.findUnderfundedAgents()).toEqual([]);
    await repo.reservePending(bond.bond_id, 700);
    expect(await svc.findUnderfundedAgents()).toEqual([PUBKEY]);
  });
});
