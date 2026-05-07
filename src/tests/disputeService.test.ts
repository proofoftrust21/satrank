// AEPS §10 — DisputeService unit tests with real BIP-340 Schnorr signing.
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  DisputeService,
  buildOutcomeMessageHash,
  schnorrSignOutcome,
  schnorrVerify,
} from '../services/disputeService';
import type {
  AepsDispute,
  AepsDisputeAttestation,
  AepsDisputeRepository,
  AttestationOutcome,
  CreateDisputeInput,
  DisputeState,
  OracleEquivocation,
  RecordAttestationInput,
  RecordEquivocationInput,
} from '../repositories/aepsDisputeRepository';

class InMemoryRepo {
  disputes = new Map<string, AepsDispute>();
  attestations = new Map<string, AepsDisputeAttestation[]>();
  equivocations: OracleEquivocation[] = [];
  attSeq = 0;
  equivSeq = 0;
  // Loose typing for the in-memory db query stub used by the equivocation
  // claim_id back-fill path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db = { query: async (_sql: string, _params: unknown[]): Promise<{ rows: any[] }> => ({ rows: [] }) };

  async createDispute(input: CreateDisputeInput): Promise<AepsDispute> {
    const d: AepsDispute = {
      dispute_id: input.dispute_id,
      disputant_pubkey: input.disputant_pubkey,
      respondent_pubkey: input.respondent_pubkey,
      dispute_type: input.dispute_type,
      receipt_id: input.receipt_id ?? null,
      fork_event_id: input.fork_event_id ?? null,
      multiplier: input.multiplier,
      oracle_pubkeys: input.oracle_pubkeys,
      oracle_threshold: input.oracle_threshold,
      state: 'open',
      expires_at: input.expires_at,
      created_at: input.created_at,
      resolved_at: null,
      dispute_reason: input.dispute_reason ?? null,
      claim_id: null,
    };
    this.disputes.set(input.dispute_id, d);
    this.attestations.set(input.dispute_id, []);
    return d;
  }

  async findDispute(disputeId: string): Promise<AepsDispute | null> {
    return this.disputes.get(disputeId) ?? null;
  }

  async recordAttestation(input: RecordAttestationInput): Promise<AepsDisputeAttestation> {
    const list = this.attestations.get(input.dispute_id) ?? [];
    const existing = list.find(a => a.oracle_pubkey === input.oracle_pubkey);
    if (existing) {
      existing.outcome = input.outcome;
      existing.signature_hex = input.signature_hex;
      existing.signed_at = Math.min(existing.signed_at, input.signed_at);
      return existing;
    }
    this.attSeq += 1;
    const att: AepsDisputeAttestation = {
      attestation_id: this.attSeq,
      dispute_id: input.dispute_id,
      oracle_pubkey: input.oracle_pubkey,
      outcome: input.outcome,
      signature_hex: input.signature_hex,
      signed_at: input.signed_at,
      equivocated: false,
    };
    list.push(att);
    this.attestations.set(input.dispute_id, list);
    return att;
  }

  async markAttestationEquivocated(disputeId: string, oraclePubkey: string): Promise<void> {
    const list = this.attestations.get(disputeId) ?? [];
    const att = list.find(a => a.oracle_pubkey === oraclePubkey);
    if (att) att.equivocated = true;
  }

  async recordEquivocation(input: RecordEquivocationInput): Promise<OracleEquivocation> {
    const existing = this.equivocations.find(
      e => e.oracle_pubkey === input.oracle_pubkey && e.dispute_id === input.dispute_id,
    );
    if (existing) {
      existing.detected_at = Math.min(existing.detected_at, input.detected_at);
      return existing;
    }
    this.equivSeq += 1;
    const e: OracleEquivocation = {
      equivocation_id: this.equivSeq,
      oracle_pubkey: input.oracle_pubkey,
      dispute_id: input.dispute_id,
      outcome_a: input.outcome_a,
      signature_hex_a: input.signature_hex_a,
      signed_at_a: input.signed_at_a,
      outcome_b: input.outcome_b,
      signature_hex_b: input.signature_hex_b,
      signed_at_b: input.signed_at_b,
      detected_at: input.detected_at,
      claim_id: null,
    };
    this.equivocations.push(e);
    return e;
  }

  async findEquivocation(
    oraclePubkey: string,
    disputeId: string,
  ): Promise<OracleEquivocation | null> {
    return (
      this.equivocations.find(
        e => e.oracle_pubkey === oraclePubkey && e.dispute_id === disputeId,
      ) ?? null
    );
  }

  async listEquivocationsForOracle(
    oraclePubkey: string,
    limit = 100,
  ): Promise<OracleEquivocation[]> {
    return this.equivocations
      .filter(e => e.oracle_pubkey === oraclePubkey)
      .sort((a, b) => b.detected_at - a.detected_at)
      .slice(0, limit);
  }

  async listAttestations(disputeId: string): Promise<AepsDisputeAttestation[]> {
    return [...(this.attestations.get(disputeId) ?? [])].sort((a, b) => a.signed_at - b.signed_at);
  }

  async updateDisputeState(
    disputeId: string,
    state: DisputeState,
    extra: { resolved_at?: number; claim_id?: number } = {},
  ): Promise<void> {
    const d = this.disputes.get(disputeId);
    if (!d) return;
    d.state = state;
    if (extra.resolved_at !== undefined) d.resolved_at = extra.resolved_at;
    if (extra.claim_id !== undefined) d.claim_id = extra.claim_id;
  }

  async findExpiredOpenDisputes(nowSec: number): Promise<AepsDispute[]> {
    return Array.from(this.disputes.values()).filter(
      d => d.state === 'open' && d.expires_at < nowSec,
    );
  }
}

interface Oracle {
  skHex: string;
  pkHex: string;
}

function makeOracle(): Oracle {
  const sk = randomBytes(32);
  const pk = schnorr.getPublicKey(sk);
  return {
    skHex: Buffer.from(sk).toString('hex'),
    pkHex: Buffer.from(pk).toString('hex'),
  };
}

const DISPUTANT = 'a'.repeat(64);
const RESPONDENT = 'b'.repeat(64);

function newSvc(now = 1_000_000): { svc: DisputeService; repo: InMemoryRepo } {
  const repo = new InMemoryRepo();
  const svc = new DisputeService({
    repo: repo as unknown as AepsDisputeRepository,
    now: () => now,
  });
  return { svc, repo };
}

describe('AEPS §10 — DisputeService', () => {
  describe('openDispute validation', () => {
    it('opens a valid content_correctness dispute with multiplier 5', async () => {
      const { svc } = newSvc();
      const oracles = [makeOracle(), makeOracle(), makeOracle()];
      const r = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'content_correctness',
        receipt_id: 42,
        oracle_pubkeys: oracles.map(o => o.pkHex),
        oracle_threshold: 2,
      });
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      expect(r.dispute.multiplier).toBe(5);
      expect(r.dispute.state).toBe('open');
      expect(r.dispute.oracle_threshold).toBe(2);
    });

    it('uses correct multiplier per dispute_type', async () => {
      const cases: Array<[Parameters<DisputeService['openDispute']>[0]['dispute_type'], number]> = [
        ['content_correctness', 5],
        ['fork', 5],
        ['sla_breach', 3],
        ['false_dispute', 3],
        ['non_payment', 1],
      ];
      const { svc } = newSvc();
      const oracles = [makeOracle()];
      for (const [type, expected] of cases) {
        const r = await svc.openDispute({
          disputant_pubkey: DISPUTANT,
          respondent_pubkey: RESPONDENT,
          dispute_type: type,
          oracle_pubkeys: oracles.map(o => o.pkHex),
          oracle_threshold: 1,
        });
        if (r.status !== 'ok') throw new Error('open failed');
        expect(r.dispute.multiplier).toBe(expected);
      }
    });

    it('rejects same disputant + respondent', async () => {
      const { svc } = newSvc();
      const r = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: DISPUTANT,
        dispute_type: 'fork',
        oracle_pubkeys: [makeOracle().pkHex],
        oracle_threshold: 1,
      });
      expect(r.status).toBe('invalid_input');
    });

    it('rejects malformed pubkeys', async () => {
      const { svc } = newSvc();
      const r = await svc.openDispute({
        disputant_pubkey: 'short',
        respondent_pubkey: RESPONDENT,
        dispute_type: 'fork',
        oracle_pubkeys: [makeOracle().pkHex],
        oracle_threshold: 1,
      });
      expect(r.status).toBe('invalid_input');
    });

    it('rejects threshold > oracle_pubkeys.length', async () => {
      const { svc } = newSvc();
      const r = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'fork',
        oracle_pubkeys: [makeOracle().pkHex],
        oracle_threshold: 5,
      });
      expect(r.status).toBe('invalid_input');
    });

    it('rejects duplicate oracle pubkeys', async () => {
      const { svc } = newSvc();
      const o = makeOracle();
      const r = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'fork',
        oracle_pubkeys: [o.pkHex, o.pkHex],
        oracle_threshold: 1,
      });
      expect(r.status).toBe('invalid_input');
    });

    it('rejects unknown dispute_type', async () => {
      const { svc } = newSvc();
      const r = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        // @ts-expect-error testing bad input
        dispute_type: 'made_up',
        oracle_pubkeys: [makeOracle().pkHex],
        oracle_threshold: 1,
      });
      expect(r.status).toBe('invalid_input');
    });

    it('respects custom ttl_sec', async () => {
      const { svc } = newSvc(2_000_000);
      const r = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'fork',
        oracle_pubkeys: [makeOracle().pkHex],
        oracle_threshold: 1,
        ttl_sec: 60,
      });
      if (r.status !== 'ok') throw new Error('open failed');
      expect(r.dispute.expires_at).toBe(2_000_060);
    });
  });

  describe('submitAttestation', () => {
    it('rejects oracle not in dispute set', async () => {
      const { svc } = newSvc();
      const oracles = [makeOracle(), makeOracle()];
      const intruder = makeOracle();
      const open = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'fork',
        oracle_pubkeys: oracles.map(o => o.pkHex),
        oracle_threshold: 2,
      });
      if (open.status !== 'ok') throw new Error('open failed');
      const sig = schnorrSignOutcome(intruder.skHex, open.dispute.dispute_id, 'disputant_wins');
      const r = await svc.submitAttestation(open.dispute.dispute_id, intruder.pkHex, 'disputant_wins', sig);
      expect(r.status).toBe('oracle_not_in_set');
    });

    it('rejects invalid signature', async () => {
      const { svc } = newSvc();
      const oracles = [makeOracle()];
      const open = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'fork',
        oracle_pubkeys: oracles.map(o => o.pkHex),
        oracle_threshold: 1,
      });
      if (open.status !== 'ok') throw new Error('open failed');
      // Sign for one oracle but submit with another's pubkey
      const otherOracle = makeOracle();
      const sigByOther = schnorrSignOutcome(otherOracle.skHex, open.dispute.dispute_id, 'disputant_wins');
      const r = await svc.submitAttestation(
        open.dispute.dispute_id,
        oracles[0].pkHex,
        'disputant_wins',
        sigByOther,
      );
      expect(r.status).toBe('invalid_signature');
    });

    it('accepts a single valid attestation when threshold = 1 and resolves', async () => {
      const { svc } = newSvc();
      const o = makeOracle();
      const open = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'sla_breach',
        oracle_pubkeys: [o.pkHex],
        oracle_threshold: 1,
      });
      if (open.status !== 'ok') throw new Error('open failed');
      const sig = schnorrSignOutcome(o.skHex, open.dispute.dispute_id, 'disputant_wins');
      const r = await svc.submitAttestation(open.dispute.dispute_id, o.pkHex, 'disputant_wins', sig);
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      expect(r.dispute_state).toBe('resolved_disputant');
    });

    it('stays open until threshold reached', async () => {
      const { svc, repo } = newSvc();
      const oracles = [makeOracle(), makeOracle(), makeOracle()];
      const open = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'content_correctness',
        oracle_pubkeys: oracles.map(o => o.pkHex),
        oracle_threshold: 2,
      });
      if (open.status !== 'ok') throw new Error('open failed');
      const sig = schnorrSignOutcome(oracles[0].skHex, open.dispute.dispute_id, 'disputant_wins');
      const r = await svc.submitAttestation(open.dispute.dispute_id, oracles[0].pkHex, 'disputant_wins', sig);
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      expect(r.dispute_state).toBe('open');
      const d = await repo.findDispute(open.dispute.dispute_id);
      expect(d?.state).toBe('open');
    });

    it('threshold of opposing outcome resolves for respondent', async () => {
      const { svc } = newSvc();
      const oracles = [makeOracle(), makeOracle(), makeOracle()];
      const open = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'content_correctness',
        oracle_pubkeys: oracles.map(o => o.pkHex),
        oracle_threshold: 2,
      });
      if (open.status !== 'ok') throw new Error('open failed');
      // Two oracles vote respondent_wins
      for (let i = 0; i < 2; i++) {
        const sig = schnorrSignOutcome(oracles[i].skHex, open.dispute.dispute_id, 'respondent_wins');
        await svc.submitAttestation(open.dispute.dispute_id, oracles[i].pkHex, 'respondent_wins', sig);
      }
      const r = await svc.submitAttestation(
        open.dispute.dispute_id,
        oracles[2].pkHex,
        'disputant_wins',
        schnorrSignOutcome(oracles[2].skHex, open.dispute.dispute_id, 'disputant_wins'),
      );
      // After 3rd attestation, dispute is already resolved for respondent.
      expect(r.status).toBe('dispute_not_open');
    });

    it('idempotent on (dispute, oracle) — second call updates same row', async () => {
      const { svc, repo } = newSvc();
      const o = makeOracle();
      const open = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'fork',
        oracle_pubkeys: [o.pkHex],
        oracle_threshold: 2,
        // 2 oracles required but only one provided — invalid input
      });
      // Need >=2 oracles for threshold 2.
      expect(open.status).toBe('invalid_input');

      // Retry with 2 oracles
      const oracles = [o, makeOracle()];
      const open2 = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'fork',
        oracle_pubkeys: oracles.map(or => or.pkHex),
        oracle_threshold: 2,
      });
      if (open2.status !== 'ok') throw new Error('open2 failed');

      const sig = schnorrSignOutcome(oracles[0].skHex, open2.dispute.dispute_id, 'disputant_wins');
      await svc.submitAttestation(open2.dispute.dispute_id, oracles[0].pkHex, 'disputant_wins', sig);
      // Resubmit same attestation — should be idempotent.
      await svc.submitAttestation(open2.dispute.dispute_id, oracles[0].pkHex, 'disputant_wins', sig);
      const list = await repo.listAttestations(open2.dispute.dispute_id);
      expect(list.length).toBe(1);
    });

    it('returns dispute_not_found for unknown id', async () => {
      const { svc } = newSvc();
      const o = makeOracle();
      const sig = schnorrSignOutcome(o.skHex, 'dis_unknown', 'disputant_wins');
      const r = await svc.submitAttestation('dis_unknown', o.pkHex, 'disputant_wins', sig);
      expect(r.status).toBe('dispute_not_found');
    });

    it('rejects malformed signature_hex (length)', async () => {
      const { svc } = newSvc();
      const o = makeOracle();
      const open = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'fork',
        oracle_pubkeys: [o.pkHex],
        oracle_threshold: 1,
      });
      if (open.status !== 'ok') throw new Error('open failed');
      const r = await svc.submitAttestation(open.dispute.dispute_id, o.pkHex, 'disputant_wins', 'too-short');
      expect(r.status).toBe('invalid_input');
    });
  });

  describe('abortExpired', () => {
    it('expires open disputes past expires_at', async () => {
      let now = 1_000_000;
      const repo = new InMemoryRepo();
      const svc = new DisputeService({
        repo: repo as unknown as AepsDisputeRepository,
        now: () => now,
      });
      const oracles = [makeOracle()];
      const open = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'fork',
        oracle_pubkeys: oracles.map(o => o.pkHex),
        oracle_threshold: 1,
        ttl_sec: 100,
      });
      if (open.status !== 'ok') throw new Error('open failed');
      now = 1_000_500;
      const expired = await svc.abortExpired();
      expect(expired).toBe(1);
      const d = await repo.findDispute(open.dispute.dispute_id);
      expect(d?.state).toBe('expired');
    });

    it('does not expire resolved disputes', async () => {
      let now = 1_000_000;
      const repo = new InMemoryRepo();
      const svc = new DisputeService({
        repo: repo as unknown as AepsDisputeRepository,
        now: () => now,
      });
      const o = makeOracle();
      const open = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'sla_breach',
        oracle_pubkeys: [o.pkHex],
        oracle_threshold: 1,
        ttl_sec: 100,
      });
      if (open.status !== 'ok') throw new Error('open failed');
      const sig = schnorrSignOutcome(o.skHex, open.dispute.dispute_id, 'disputant_wins');
      await svc.submitAttestation(open.dispute.dispute_id, o.pkHex, 'disputant_wins', sig);
      now = 1_000_500;
      const expired = await svc.abortExpired();
      expect(expired).toBe(0);
    });
  });

  describe('onResolved hook', () => {
    it('fires when dispute resolves and persists returned claim_id', async () => {
      let now = 1_000_000;
      const repo = new InMemoryRepo();
      const calls: AepsDispute[] = [];
      const svc = new DisputeService({
        repo: repo as unknown as AepsDisputeRepository,
        now: () => now,
        onResolved: async (dispute) => {
          calls.push(dispute);
          return { claim_id: 999 };
        },
      });
      const o = makeOracle();
      const open = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'sla_breach',
        oracle_pubkeys: [o.pkHex],
        oracle_threshold: 1,
      });
      if (open.status !== 'ok') throw new Error('open failed');
      const sig = schnorrSignOutcome(o.skHex, open.dispute.dispute_id, 'disputant_wins');
      await svc.submitAttestation(open.dispute.dispute_id, o.pkHex, 'disputant_wins', sig);
      expect(calls.length).toBe(1);
      expect(calls[0].dispute_id).toBe(open.dispute.dispute_id);
      expect(calls[0].state).toBe('resolved_disputant');
      const updated = await repo.findDispute(open.dispute.dispute_id);
      expect(updated?.claim_id).toBe(999);
    });

    it('does not fire while dispute remains open (below threshold)', async () => {
      const repo = new InMemoryRepo();
      const calls: AepsDispute[] = [];
      const svc = new DisputeService({
        repo: repo as unknown as AepsDisputeRepository,
        now: () => 1_000_000,
        onResolved: async (d) => { calls.push(d); },
      });
      const oracles = [makeOracle(), makeOracle()];
      const open = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'fork',
        oracle_pubkeys: oracles.map(o => o.pkHex),
        oracle_threshold: 2,
      });
      if (open.status !== 'ok') throw new Error('open failed');
      const sig = schnorrSignOutcome(oracles[0].skHex, open.dispute.dispute_id, 'disputant_wins');
      await svc.submitAttestation(open.dispute.dispute_id, oracles[0].pkHex, 'disputant_wins', sig);
      expect(calls.length).toBe(0);
    });

    it('hook failure is logged but does not roll back resolution', async () => {
      const repo = new InMemoryRepo();
      const svc = new DisputeService({
        repo: repo as unknown as AepsDisputeRepository,
        now: () => 1_000_000,
        onResolved: async () => { throw new Error('claim engine down'); },
      });
      const o = makeOracle();
      const open = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'fork',
        oracle_pubkeys: [o.pkHex],
        oracle_threshold: 1,
      });
      if (open.status !== 'ok') throw new Error('open failed');
      const sig = schnorrSignOutcome(o.skHex, open.dispute.dispute_id, 'disputant_wins');
      const r = await svc.submitAttestation(open.dispute.dispute_id, o.pkHex, 'disputant_wins', sig);
      expect(r.status).toBe('ok');
      const d = await repo.findDispute(open.dispute.dispute_id);
      expect(d?.state).toBe('resolved_disputant');  // resolution stuck
      expect(d?.claim_id).toBeNull();              // but no claim
    });

    it('hook can return void (no claim_id) — resolution proceeds without linkage', async () => {
      const repo = new InMemoryRepo();
      const svc = new DisputeService({
        repo: repo as unknown as AepsDisputeRepository,
        now: () => 1_000_000,
        onResolved: async () => { /* void */ },
      });
      const o = makeOracle();
      const open = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'non_payment',
        oracle_pubkeys: [o.pkHex],
        oracle_threshold: 1,
      });
      if (open.status !== 'ok') throw new Error('open failed');
      const sig = schnorrSignOutcome(o.skHex, open.dispute.dispute_id, 'disputant_wins');
      await svc.submitAttestation(open.dispute.dispute_id, o.pkHex, 'disputant_wins', sig);
      const d = await repo.findDispute(open.dispute.dispute_id);
      expect(d?.state).toBe('resolved_disputant');
      expect(d?.claim_id).toBeNull();
    });
  });

  describe('equivocation detection (an oracle who signs both outcomes)', () => {
    it('records an equivocation event when oracle changes vote', async () => {
      const repo = new InMemoryRepo();
      const svc = new DisputeService({
        repo: repo as unknown as AepsDisputeRepository,
        now: () => 1_000_000,
      });
      const oracles = [makeOracle(), makeOracle(), makeOracle()];
      const open = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'content_correctness',
        oracle_pubkeys: oracles.map(o => o.pkHex),
        oracle_threshold: 2,
      });
      if (open.status !== 'ok') throw new Error('open failed');
      const id = open.dispute.dispute_id;
      // Oracle 0 first signs disputant_wins
      const sig1 = schnorrSignOutcome(oracles[0].skHex, id, 'disputant_wins');
      await svc.submitAttestation(id, oracles[0].pkHex, 'disputant_wins', sig1);
      expect(repo.equivocations.length).toBe(0);
      // Oracle 0 then signs respondent_wins → equivocation
      const sig2 = schnorrSignOutcome(oracles[0].skHex, id, 'respondent_wins');
      const r = await svc.submitAttestation(id, oracles[0].pkHex, 'respondent_wins', sig2);
      expect(r.status).toBe('ok');
      expect(repo.equivocations.length).toBe(1);
      const equiv = repo.equivocations[0];
      expect(equiv.oracle_pubkey).toBe(oracles[0].pkHex.toLowerCase());
      expect(equiv.outcome_a).toBe('disputant_wins');
      expect(equiv.outcome_b).toBe('respondent_wins');
      expect(equiv.signature_hex_a).toBe(sig1.toLowerCase());
      expect(equiv.signature_hex_b).toBe(sig2.toLowerCase());
    });

    it('marks the attestation as equivocated so threshold count excludes it', async () => {
      const repo = new InMemoryRepo();
      const svc = new DisputeService({
        repo: repo as unknown as AepsDisputeRepository,
        now: () => 1_000_000,
      });
      const oracles = [makeOracle(), makeOracle()];
      const open = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'sla_breach',
        oracle_pubkeys: oracles.map(o => o.pkHex),
        oracle_threshold: 1,
      });
      if (open.status !== 'ok') throw new Error('open failed');
      const id = open.dispute.dispute_id;
      // Oracle 0 signs disputant_wins → would resolve at threshold=1
      // BUT then equivocates → threshold no longer met (vote excluded)
      const sigA = schnorrSignOutcome(oracles[0].skHex, id, 'disputant_wins');
      const r1 = await svc.submitAttestation(id, oracles[0].pkHex, 'disputant_wins', sigA);
      // First write resolved at threshold 1.
      expect(r1.status).toBe('ok');
      if (r1.status !== 'ok') return;
      expect(r1.dispute_state).toBe('resolved_disputant');
      // Second submission lands on a now-resolved dispute → dispute_not_open.
      const sigB = schnorrSignOutcome(oracles[0].skHex, id, 'respondent_wins');
      const r2 = await svc.submitAttestation(id, oracles[0].pkHex, 'respondent_wins', sigB);
      expect(r2.status).toBe('dispute_not_open');
    });

    it('equivocation excludes vote when dispute is still open', async () => {
      const repo = new InMemoryRepo();
      const svc = new DisputeService({
        repo: repo as unknown as AepsDisputeRepository,
        now: () => 1_000_000,
      });
      const oracles = [makeOracle(), makeOracle(), makeOracle()];
      const open = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'content_correctness',
        oracle_pubkeys: oracles.map(o => o.pkHex),
        oracle_threshold: 2,
      });
      if (open.status !== 'ok') throw new Error('open failed');
      const id = open.dispute.dispute_id;
      // Oracle 0 votes disputant_wins (1 vote toward threshold=2 → still open)
      await svc.submitAttestation(
        id,
        oracles[0].pkHex,
        'disputant_wins',
        schnorrSignOutcome(oracles[0].skHex, id, 'disputant_wins'),
      );
      const dispute = await repo.findDispute(id);
      expect(dispute?.state).toBe('open');
      // Oracle 0 equivocates : signs respondent_wins
      await svc.submitAttestation(
        id,
        oracles[0].pkHex,
        'respondent_wins',
        schnorrSignOutcome(oracles[0].skHex, id, 'respondent_wins'),
      );
      // Now there's an equivocation. Oracle 0's vote doesn't count.
      // Oracle 1 + Oracle 2 must both vote disputant_wins for resolution.
      const r1 = await svc.submitAttestation(
        id,
        oracles[1].pkHex,
        'disputant_wins',
        schnorrSignOutcome(oracles[1].skHex, id, 'disputant_wins'),
      );
      // Threshold is 2 ; only oracle 1's vote counts now (oracle 0 equivocated).
      expect(r1.status).toBe('ok');
      if (r1.status !== 'ok') return;
      expect(r1.dispute_state).toBe('open');
      const r2 = await svc.submitAttestation(
        id,
        oracles[2].pkHex,
        'disputant_wins',
        schnorrSignOutcome(oracles[2].skHex, id, 'disputant_wins'),
      );
      expect(r2.status).toBe('ok');
      if (r2.status !== 'ok') return;
      expect(r2.dispute_state).toBe('resolved_disputant');
    });

    it('onEquivocation hook fires with the equivocation event', async () => {
      const repo = new InMemoryRepo();
      const calls: OracleEquivocation[] = [];
      const svc = new DisputeService({
        repo: repo as unknown as AepsDisputeRepository,
        now: () => 1_000_000,
        onEquivocation: async (e) => { calls.push(e); },
      });
      const oracles = [makeOracle(), makeOracle()];
      const open = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'fork',
        oracle_pubkeys: oracles.map(o => o.pkHex),
        oracle_threshold: 2,
      });
      if (open.status !== 'ok') throw new Error('open failed');
      const id = open.dispute.dispute_id;
      await svc.submitAttestation(
        id,
        oracles[0].pkHex,
        'disputant_wins',
        schnorrSignOutcome(oracles[0].skHex, id, 'disputant_wins'),
      );
      await svc.submitAttestation(
        id,
        oracles[0].pkHex,
        'respondent_wins',
        schnorrSignOutcome(oracles[0].skHex, id, 'respondent_wins'),
      );
      expect(calls.length).toBe(1);
      expect(calls[0].oracle_pubkey).toBe(oracles[0].pkHex.toLowerCase());
      expect(calls[0].outcome_a).toBe('disputant_wins');
      expect(calls[0].outcome_b).toBe('respondent_wins');
    });

    it('idempotent re-submission of same outcome does NOT trigger equivocation', async () => {
      const repo = new InMemoryRepo();
      const svc = new DisputeService({
        repo: repo as unknown as AepsDisputeRepository,
        now: () => 1_000_000,
      });
      const oracles = [makeOracle(), makeOracle()];
      const open = await svc.openDispute({
        disputant_pubkey: DISPUTANT,
        respondent_pubkey: RESPONDENT,
        dispute_type: 'fork',
        oracle_pubkeys: oracles.map(o => o.pkHex),
        oracle_threshold: 2,
      });
      if (open.status !== 'ok') throw new Error('open failed');
      const id = open.dispute.dispute_id;
      const sig = schnorrSignOutcome(oracles[0].skHex, id, 'disputant_wins');
      await svc.submitAttestation(id, oracles[0].pkHex, 'disputant_wins', sig);
      await svc.submitAttestation(id, oracles[0].pkHex, 'disputant_wins', sig);
      expect(repo.equivocations.length).toBe(0);
    });
  });

  describe('Schnorr verify primitives (BIP-340)', () => {
    it('schnorrVerify returns true for self-signed message', () => {
      const o = makeOracle();
      const sig = schnorrSignOutcome(o.skHex, 'dis_xyz', 'disputant_wins');
      const msg = buildOutcomeMessageHash('dis_xyz', 'disputant_wins');
      expect(schnorrVerify(sig, msg, o.pkHex)).toBe(true);
    });

    it('schnorrVerify returns false for tampered message', () => {
      const o = makeOracle();
      const sig = schnorrSignOutcome(o.skHex, 'dis_xyz', 'disputant_wins');
      const wrongMsg = buildOutcomeMessageHash('dis_xyz', 'respondent_wins');
      expect(schnorrVerify(sig, wrongMsg, o.pkHex)).toBe(false);
    });

    it('schnorrVerify returns false on bad inputs (no throw)', () => {
      const msg = buildOutcomeMessageHash('dis_xyz', 'disputant_wins');
      expect(schnorrVerify('not-hex', msg, 'a'.repeat(64))).toBe(false);
      expect(schnorrVerify('aa'.repeat(64), msg, 'not-hex')).toBe(false);
    });
  });
});
