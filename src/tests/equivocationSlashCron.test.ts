// AEPS §10 + §7.2 — EquivocationSlashCron unit tests with stubbed repos.
import { describe, it, expect } from 'vitest';
import {
  EquivocationSlashCron,
  computePayouts,
} from '../services/equivocationSlashCron';
import type {
  AepsOracleSlashRepository,
  OracleSlashIntent,
} from '../repositories/aepsOracleSlashRepository';
import type { OperatorBondRepository } from '../repositories/operatorBondRepository';

class StubSlashRepo {
  intents: OracleSlashIntent[] = [];
  executed: Array<{ id: number; payouts: ReturnType<typeof computePayouts> }> = [];

  async findReservedReady(graceSec: number, nowSec: number): Promise<OracleSlashIntent[]> {
    return this.intents.filter(
      i => i.state === 'reserved' && i.reserved_at !== null && i.reserved_at + graceSec <= nowSec,
    );
  }

  async transitionToExecuted(
    slashIntentId: number,
    executedAt: number,
    payouts: ReturnType<typeof computePayouts>,
  ): Promise<void> {
    const intent = this.intents.find(i => i.slash_intent_id === slashIntentId);
    if (!intent || intent.state !== 'reserved') return;
    intent.state = 'executed';
    intent.executed_at = executedAt;
    intent.payout_disputant_sats = payouts.payout_disputant_sats;
    intent.payout_observer_sats = payouts.payout_observer_sats;
    intent.payout_burned_sats = payouts.payout_burned_sats;
    this.executed.push({ id: slashIntentId, payouts });
  }

  async findByEquivocation() { return null; }
  async listForOracle() { return []; }
  async transitionToReserved() {}
  async createOrGet() { throw new Error('not used'); }
}

class StubBondRepo {
  bonds: Map<number, { committed: number; pending: number; slashed: number }> = new Map();
  commitResults: boolean[] = [];

  async commitSlash(bondId: number, sats: number, _settledAt: number): Promise<boolean> {
    const ok = this.commitResults.length > 0 ? (this.commitResults.shift() ?? true) : true;
    if (!ok) return false;
    const b = this.bonds.get(bondId);
    if (!b) return false;
    if (b.pending < sats) return false;
    b.pending -= sats;
    b.slashed += sats;
    return true;
  }
}

function fakeIntent(overrides: Partial<OracleSlashIntent> = {}): OracleSlashIntent {
  return {
    slash_intent_id: 1,
    oracle_pubkey: 'aa'.repeat(32),
    equivocation_id: 10,
    bond_id: 7,
    slash_sats: 250_000,
    state: 'reserved',
    created_at: 1_000_000,
    reserved_at: 1_000_000,
    executed_at: null,
    payout_disputant_sats: null,
    payout_observer_sats: null,
    payout_burned_sats: null,
    ...overrides,
  };
}

describe('AEPS §10 §7.2 — computePayouts', () => {
  it('80/15/5 split for round numbers', () => {
    const p = computePayouts(10_000);
    expect(p.payout_disputant_sats).toBe(8_000);
    expect(p.payout_observer_sats).toBe(1_500);
    expect(p.payout_burned_sats).toBe(500);
    expect(p.payout_disputant_sats + p.payout_observer_sats + p.payout_burned_sats).toBe(10_000);
  });

  it('sum equals input on rounding-edge values', () => {
    for (const sats of [1, 7, 13, 99, 1001, 250_000, 1_234_567]) {
      const p = computePayouts(sats);
      expect(p.payout_disputant_sats + p.payout_observer_sats + p.payout_burned_sats).toBe(sats);
    }
  });

  it('rounding remainder lands in burn share', () => {
    // 1 sat slash : 80%/15%/5% all floor to 0, burn absorbs the rest.
    const p = computePayouts(1);
    expect(p.payout_disputant_sats).toBe(0);
    expect(p.payout_observer_sats).toBe(0);
    expect(p.payout_burned_sats).toBe(1);
  });

  it('rejects negative input', () => {
    expect(() => computePayouts(-1)).toThrow();
  });
});

function newCron(now = 2_000_000) {
  const slashRepo = new StubSlashRepo();
  const bondRepo = new StubBondRepo();
  const cron = new EquivocationSlashCron({
    slashRepo: slashRepo as unknown as AepsOracleSlashRepository,
    bondRepo: bondRepo as unknown as OperatorBondRepository,
    graceSec: 100,
    now: () => now,
  });
  return { cron, slashRepo, bondRepo };
}

describe('AEPS §10 — EquivocationSlashCron.runCycle', () => {
  it('skips intents inside grace period', async () => {
    const { cron, slashRepo } = newCron(1_000_050);  // only 50s after reserved
    slashRepo.intents.push(fakeIntent());
    const r = await cron.runCycle();
    expect(r.considered).toBe(0);
    expect(slashRepo.intents[0].state).toBe('reserved');
  });

  it('executes intent past grace, moves bond pending → slashed', async () => {
    const { cron, slashRepo, bondRepo } = newCron(1_000_200);
    slashRepo.intents.push(fakeIntent());
    bondRepo.bonds.set(7, { committed: 1_000_000, pending: 250_000, slashed: 0 });
    const r = await cron.runCycle();
    expect(r.considered).toBe(1);
    expect(r.executed).toBe(1);
    expect(r.skipped_no_bond).toBe(0);
    expect(r.skipped_pending_too_low).toBe(0);
    expect(slashRepo.intents[0].state).toBe('executed');
    const bond = bondRepo.bonds.get(7)!;
    expect(bond.pending).toBe(0);
    expect(bond.slashed).toBe(250_000);
  });

  it('records §7.2 payout shares on executed intent', async () => {
    const { cron, slashRepo, bondRepo } = newCron(1_000_200);
    slashRepo.intents.push(fakeIntent({ slash_sats: 100_000 }));
    bondRepo.bonds.set(7, { committed: 200_000, pending: 100_000, slashed: 0 });
    await cron.runCycle();
    const i = slashRepo.intents[0];
    expect(i.payout_disputant_sats).toBe(80_000);
    expect(i.payout_observer_sats).toBe(15_000);
    expect(i.payout_burned_sats).toBe(5_000);
  });

  it('skips intent when bond_id is null', async () => {
    const { cron, slashRepo, bondRepo } = newCron(1_000_200);
    // findReservedReady returns intents with bond_id null too in some
    // edge cases (e.g. test fixtures) — cron handles gracefully.
    slashRepo.intents.push(fakeIntent({ bond_id: null }));
    bondRepo.bonds.set(7, { committed: 1_000_000, pending: 0, slashed: 0 });
    const r = await cron.runCycle();
    expect(r.considered).toBe(1);
    expect(r.skipped_no_bond).toBe(1);
    expect(r.executed).toBe(0);
  });

  it('skips when commitSlash returns false (race)', async () => {
    const { cron, slashRepo, bondRepo } = newCron(1_000_200);
    slashRepo.intents.push(fakeIntent());
    bondRepo.bonds.set(7, { committed: 1_000_000, pending: 250_000, slashed: 0 });
    bondRepo.commitResults = [false];
    const r = await cron.runCycle();
    expect(r.skipped_pending_too_low).toBe(1);
    expect(r.executed).toBe(0);
    expect(slashRepo.intents[0].state).toBe('reserved');  // unchanged
  });

  it('processes multiple ready intents in one cycle', async () => {
    const { cron, slashRepo, bondRepo } = newCron(1_000_200);
    slashRepo.intents.push(fakeIntent({ slash_intent_id: 1, equivocation_id: 1, bond_id: 7 }));
    slashRepo.intents.push(fakeIntent({ slash_intent_id: 2, equivocation_id: 2, bond_id: 8, oracle_pubkey: 'bb'.repeat(32) }));
    bondRepo.bonds.set(7, { committed: 1_000_000, pending: 250_000, slashed: 0 });
    bondRepo.bonds.set(8, { committed: 1_000_000, pending: 250_000, slashed: 0 });
    const r = await cron.runCycle();
    expect(r.executed).toBe(2);
  });

  it('does not double-execute already-executed intent', async () => {
    const { cron, slashRepo, bondRepo } = newCron(1_000_200);
    slashRepo.intents.push(fakeIntent({ state: 'executed' }));
    bondRepo.bonds.set(7, { committed: 1_000_000, pending: 0, slashed: 250_000 });
    const r = await cron.runCycle();
    expect(r.considered).toBe(0);
    expect(r.executed).toBe(0);
  });
});
