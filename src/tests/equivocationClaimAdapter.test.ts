// AEPS §10 — EquivocationClaimAdapter unit tests with stubbed bond + slash repos.
import { describe, it, expect } from 'vitest';
import { EquivocationClaimAdapter } from '../services/equivocationClaimAdapter';
import type { OracleEquivocation } from '../repositories/aepsDisputeRepository';
import type {
  AepsOracleSlashRepository,
  CreateSlashIntentInput,
  OracleSlashIntent,
} from '../repositories/aepsOracleSlashRepository';
import type { OperatorBondRepository } from '../repositories/operatorBondRepository';

type OperatorBond = {
  bond_id: number;
  operator_pubkey: string;
  bond_committed_sats: number;
  bond_slashed_sats: number;
  bond_pending_sats: number;
};

class StubBondRepo {
  bonds: OperatorBond[] = [];
  reserveResults: boolean[] = [];

  async findActiveByOperator(pk: string): Promise<OperatorBond[]> {
    return this.bonds.filter(b => b.operator_pubkey === pk);
  }

  async reservePending(bondId: number, sats: number): Promise<boolean> {
    const ok = this.reserveResults.length > 0 ? (this.reserveResults.shift() ?? true) : true;
    if (ok) {
      const b = this.bonds.find(x => x.bond_id === bondId);
      if (b) b.bond_pending_sats += sats;
    }
    return ok;
  }
}

class StubSlashRepo {
  intents: OracleSlashIntent[] = [];
  seq = 0;

  async createOrGet(input: CreateSlashIntentInput): Promise<OracleSlashIntent> {
    const existing = this.intents.find(i => i.equivocation_id === input.equivocation_id);
    if (existing) return existing;
    this.seq += 1;
    const intent: OracleSlashIntent = {
      slash_intent_id: this.seq,
      oracle_pubkey: input.oracle_pubkey,
      equivocation_id: input.equivocation_id,
      bond_id: input.bond_id,
      slash_sats: input.slash_sats,
      state: input.state,
      created_at: input.created_at,
      reserved_at: input.reserved_at ?? null,
      executed_at: null,
      payout_disputant_sats: null,
      payout_observer_sats: null,
      payout_burned_sats: null,
    };
    this.intents.push(intent);
    return intent;
  }

  async findByEquivocation(eqId: number): Promise<OracleSlashIntent | null> {
    return this.intents.find(i => i.equivocation_id === eqId) ?? null;
  }

  async listForOracle(): Promise<OracleSlashIntent[]> { return []; }

  async transitionToReserved(): Promise<void> {}
}

const ORACLE = 'aa'.repeat(32);

function fakeEquivocation(overrides: Partial<OracleEquivocation> = {}): OracleEquivocation {
  return {
    equivocation_id: 1,
    oracle_pubkey: ORACLE,
    dispute_id: 'dis_' + 'cd'.repeat(16),
    outcome_a: 'disputant_wins',
    signature_hex_a: 'aa'.repeat(64),
    signed_at_a: 1000,
    outcome_b: 'respondent_wins',
    signature_hex_b: 'bb'.repeat(64),
    signed_at_b: 1100,
    detected_at: 1100,
    claim_id: null,
    ...overrides,
  };
}

function newAdapter(opts: { baselineSats?: number } = {}) {
  const bondRepo = new StubBondRepo();
  const slashRepo = new StubSlashRepo();
  const adapter = new EquivocationClaimAdapter({
    bondRepo: bondRepo as unknown as OperatorBondRepository,
    slashRepo: slashRepo as unknown as AepsOracleSlashRepository,
    baselineSatsOverride: opts.baselineSats,
    now: () => 2_000_000,
  });
  return { adapter, bondRepo, slashRepo };
}

describe('AEPS §10 — EquivocationClaimAdapter', () => {
  it('returns no_bond_found when oracle has no bond', async () => {
    const { adapter, slashRepo } = newAdapter();
    const r = await adapter.openSlashForEquivocation(fakeEquivocation());
    expect(r.status).toBe('no_bond_found');
    expect(slashRepo.intents.length).toBe(1);
    expect(slashRepo.intents[0].state).toBe('no_bond_found');
    expect(slashRepo.intents[0].bond_id).toBeNull();
  });

  it('reserves bond when oracle has enough committed sats', async () => {
    const { adapter, bondRepo, slashRepo } = newAdapter();
    bondRepo.bonds.push({
      bond_id: 7,
      operator_pubkey: ORACLE,
      bond_committed_sats: 1_000_000,
      bond_slashed_sats: 0,
      bond_pending_sats: 0,
    });
    const r = await adapter.openSlashForEquivocation(fakeEquivocation());
    expect(r.status).toBe('reserved');
    if (r.status !== 'reserved') return;
    expect(r.bond_id).toBe(7);
    expect(r.slash_sats).toBe(50_000 * 5);  // 5× default baseline
    expect(bondRepo.bonds[0].bond_pending_sats).toBe(250_000);
    expect(slashRepo.intents[0].state).toBe('reserved');
  });

  it('returns underfunded when bond has insufficient headroom', async () => {
    const { adapter, bondRepo, slashRepo } = newAdapter();
    bondRepo.bonds.push({
      bond_id: 7,
      operator_pubkey: ORACLE,
      bond_committed_sats: 100_000,
      bond_slashed_sats: 0,
      bond_pending_sats: 0,
    });
    const r = await adapter.openSlashForEquivocation(fakeEquivocation());
    expect(r.status).toBe('underfunded');
    if (r.status !== 'underfunded') return;
    expect(r.needed).toBe(250_000);
    expect(r.available).toBe(100_000);
    expect(slashRepo.intents[0].state).toBe('recorded');
  });

  it('uses custom baseline override', async () => {
    const { adapter, bondRepo } = newAdapter({ baselineSats: 1_000 });
    bondRepo.bonds.push({
      bond_id: 7,
      operator_pubkey: ORACLE,
      bond_committed_sats: 100_000,
      bond_slashed_sats: 0,
      bond_pending_sats: 0,
    });
    const r = await adapter.openSlashForEquivocation(fakeEquivocation());
    expect(r.status).toBe('reserved');
    if (r.status !== 'reserved') return;
    expect(r.slash_sats).toBe(5_000);  // 1k × 5
  });

  it('handles reservePending race-loss gracefully', async () => {
    const { adapter, bondRepo, slashRepo } = newAdapter();
    bondRepo.bonds.push({
      bond_id: 7,
      operator_pubkey: ORACLE,
      bond_committed_sats: 1_000_000,
      bond_slashed_sats: 0,
      bond_pending_sats: 0,
    });
    bondRepo.reserveResults = [false];  // race lost
    const r = await adapter.openSlashForEquivocation(fakeEquivocation());
    expect(r.status).toBe('race_lost');
    expect(slashRepo.intents[0].state).toBe('recorded');
  });

  it('idempotent on repeat call (existing intent returned)', async () => {
    const { adapter, bondRepo, slashRepo } = newAdapter();
    bondRepo.bonds.push({
      bond_id: 7,
      operator_pubkey: ORACLE,
      bond_committed_sats: 1_000_000,
      bond_slashed_sats: 0,
      bond_pending_sats: 0,
    });
    const r1 = await adapter.openSlashForEquivocation(fakeEquivocation());
    const r2 = await adapter.openSlashForEquivocation(fakeEquivocation());
    expect(r1.status).toBe('reserved');
    expect(r2.status).toBe('reserved');
    expect(slashRepo.intents.length).toBe(1);
    // Bond pending only incremented once.
    expect(bondRepo.bonds[0].bond_pending_sats).toBe(250_000);
  });

  it('case-insensitive oracle_pubkey match', async () => {
    const { adapter, bondRepo } = newAdapter();
    bondRepo.bonds.push({
      bond_id: 7,
      operator_pubkey: ORACLE,  // lowercase
      bond_committed_sats: 1_000_000,
      bond_slashed_sats: 0,
      bond_pending_sats: 0,
    });
    const r = await adapter.openSlashForEquivocation(
      fakeEquivocation({ oracle_pubkey: ORACLE.toUpperCase() }),
    );
    expect(r.status).toBe('reserved');
  });
});
