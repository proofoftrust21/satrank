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

const holdInvoiceServiceStub = {
  isAvailable() { return true; },
  async addHoldInvoice(req: { valueSat: number; memo?: string; expirySec: number }): Promise<{ payment_request: string; payment_hash: string; preimage: string }> {
    return {
      payment_request: `lnbc${req.valueSat}n1pStub`,
      payment_hash: `${'h'.repeat(60)}${req.valueSat.toString(16).padStart(4, '0')}`,
      preimage: 'p'.repeat(64),
    };
  },
} as Parameters<typeof AgentBondService>[0]['holdInvoiceService'];

const lndUnavailableStub = {
  isAvailable() { return false; },
  async addHoldInvoice(): Promise<{ payment_request: string; payment_hash: string; preimage: string }> {
    throw new Error('not used');
  },
} as Parameters<typeof AgentBondService>[0]['holdInvoiceService'];

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

  it('happy path : invoice issued + bond row created', async () => {
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
    expect(bond!.releasable_at).toBe(NOW + 14 * 86400);
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
