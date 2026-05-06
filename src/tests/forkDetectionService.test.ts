// AEPS §8.5 — ForkDetectionService unit tests using an in-memory repo.
import { describe, it, expect } from 'vitest';
import { ForkDetectionService } from '../services/forkDetectionService';
import type {
  AepsObserverRepository,
  ForkEvent,
  ObservedAnchor,
  ObservationSource,
  RecordForkInput,
  RecordObservationInput,
} from '../repositories/aepsObserverRepository';

class InMemoryRepo {
  observations: ObservedAnchor[] = [];
  forks: ForkEvent[] = [];
  obsSeq = 0;
  forkSeq = 0;

  async recordObservation(input: RecordObservationInput): Promise<ObservedAnchor> {
    // Idempotent on (operator, day, root, source, source_ref).
    const key = (o: { operator_pubkey: string; day_utc: string; root_hex: string; source: string; source_ref: string | null }) =>
      `${o.operator_pubkey}|${o.day_utc}|${o.root_hex}|${o.source}|${o.source_ref ?? ''}`;
    const existing = this.observations.find(o => key(o) === key({
      operator_pubkey: input.operator_pubkey,
      day_utc: input.day_utc,
      root_hex: input.root_hex,
      source: input.source,
      source_ref: input.source_ref ?? null,
    }));
    if (existing) {
      existing.observed_at = Math.min(existing.observed_at, input.observed_at);
      return existing;
    }
    this.obsSeq += 1;
    const obs: ObservedAnchor = {
      observation_id: this.obsSeq,
      operator_pubkey: input.operator_pubkey,
      day_utc: input.day_utc,
      root_hex: input.root_hex,
      source: input.source,
      source_ref: input.source_ref ?? null,
      observed_at: input.observed_at,
    };
    this.observations.push(obs);
    return obs;
  }

  async listObservationsForOperatorDay(operatorPubkey: string, dayUtc: string): Promise<ObservedAnchor[]> {
    return this.observations
      .filter(o => o.operator_pubkey === operatorPubkey && o.day_utc === dayUtc)
      .sort((a, b) => a.observed_at - b.observed_at);
  }

  async recordForkEvent(input: RecordForkInput): Promise<ForkEvent> {
    const existing = this.forks.find(
      f =>
        f.operator_pubkey === input.operator_pubkey &&
        f.day_utc === input.day_utc &&
        f.root_hex_a === input.root_hex_a &&
        f.root_hex_b === input.root_hex_b,
    );
    if (existing) {
      existing.detected_at = Math.min(existing.detected_at, input.detected_at);
      return existing;
    }
    this.forkSeq += 1;
    const fork: ForkEvent = {
      fork_event_id: this.forkSeq,
      operator_pubkey: input.operator_pubkey,
      day_utc: input.day_utc,
      root_hex_a: input.root_hex_a,
      root_hex_b: input.root_hex_b,
      observation_id_a: input.observation_id_a,
      observation_id_b: input.observation_id_b,
      detected_at: input.detected_at,
      nostr_event_id: null,
      nostr_published_at: null,
      claim_id: null,
    };
    this.forks.push(fork);
    return fork;
  }

  async listForkEvents(operatorPubkey: string | null, limit: number): Promise<ForkEvent[]> {
    let out = [...this.forks];
    if (operatorPubkey) out = out.filter(f => f.operator_pubkey === operatorPubkey);
    out.sort((a, b) => b.detected_at - a.detected_at);
    return out.slice(0, limit);
  }

  async findForkEventByKey(
    operatorPubkey: string,
    dayUtc: string,
    rootHexA: string,
    rootHexB: string,
  ): Promise<ForkEvent | null> {
    return (
      this.forks.find(
        f =>
          f.operator_pubkey === operatorPubkey &&
          f.day_utc === dayUtc &&
          f.root_hex_a === rootHexA &&
          f.root_hex_b === rootHexB,
      ) ?? null
    );
  }

  async findFirstForkEventForBucket(
    operatorPubkey: string,
    dayUtc: string,
  ): Promise<ForkEvent | null> {
    const matches = this.forks
      .filter(f => f.operator_pubkey === operatorPubkey && f.day_utc === dayUtc)
      .sort((a, b) => a.detected_at - b.detected_at || a.fork_event_id - b.fork_event_id);
    return matches[0] ?? null;
  }
}

const OPERATOR = 'a'.repeat(64);
const ROOT_X = '11'.repeat(32);
const ROOT_Y = '22'.repeat(32);
const ROOT_Z = '33'.repeat(32);

function newSvc(now = 1_000_000): { svc: ForkDetectionService; repo: InMemoryRepo } {
  const repo = new InMemoryRepo();
  const svc = new ForkDetectionService({
    repo: repo as unknown as AepsObserverRepository,
    now: () => now,
  });
  return { svc, repo };
}

async function record(
  svc: ForkDetectionService,
  ov: { day?: string; root?: string; source?: ObservationSource; ref?: string } = {},
) {
  return svc.recordObservation({
    operator_pubkey: OPERATOR,
    day_utc: ov.day ?? '2026-05-07',
    root_hex: ov.root ?? ROOT_X,
    source: ov.source ?? 'manual',
    source_ref: ov.ref,
  });
}

describe('AEPS §8.5 — ForkDetectionService', () => {
  describe('recordObservation', () => {
    it('records a valid observation and returns no fork', async () => {
      const { svc } = newSvc();
      const r = await record(svc);
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      expect(r.observation.root_hex).toBe(ROOT_X);
      expect(r.fork_event).toBeNull();
    });

    it('rejects malformed operator_pubkey', async () => {
      const { svc } = newSvc();
      const r = await svc.recordObservation({
        operator_pubkey: 'too-short',
        day_utc: '2026-05-07',
        root_hex: ROOT_X,
        source: 'manual',
      });
      expect(r.status).toBe('invalid_input');
    });

    it('rejects malformed day_utc', async () => {
      const { svc } = newSvc();
      const r = await svc.recordObservation({
        operator_pubkey: OPERATOR,
        day_utc: '2026-5-7',
        root_hex: ROOT_X,
        source: 'manual',
      });
      expect(r.status).toBe('invalid_input');
    });

    it('rejects malformed root_hex', async () => {
      const { svc } = newSvc();
      const r = await svc.recordObservation({
        operator_pubkey: OPERATOR,
        day_utc: '2026-05-07',
        root_hex: 'not-hex',
        source: 'manual',
      });
      expect(r.status).toBe('invalid_input');
    });
  });

  describe('fork detection', () => {
    it('does not flag a single observation', async () => {
      const { svc, repo } = newSvc();
      await record(svc);
      expect(repo.forks.length).toBe(0);
    });

    it('does not flag two observations of the SAME root', async () => {
      const { svc, repo } = newSvc();
      await record(svc, { source: 'self' });
      await record(svc, { source: 'l1', ref: 'txid_1' });
      expect(repo.forks.length).toBe(0);
    });

    it('flags two observations of DIFFERENT roots same operator+day', async () => {
      const { svc, repo } = newSvc();
      const r1 = await record(svc, { root: ROOT_X, source: 'self' });
      const r2 = await record(svc, { root: ROOT_Y, source: 'l1', ref: 'tx1' });
      expect(r2.status).toBe('ok');
      if (r2.status !== 'ok') return;
      expect(r2.fork_event).not.toBeNull();
      expect(repo.forks.length).toBe(1);
      // Lex order: 11... < 22...
      expect(repo.forks[0].root_hex_a).toBe(ROOT_X);
      expect(repo.forks[0].root_hex_b).toBe(ROOT_Y);
    });

    it('records fork with deterministic root ordering regardless of arrival order', async () => {
      // First fixture: X then Y. Second fixture: Y then X. Both should produce
      // the same lex-ordered (a, b) = (X, Y).
      const a = newSvc();
      const b = newSvc();
      await record(a.svc, { root: ROOT_X });
      await record(a.svc, { root: ROOT_Y, ref: 'a' });
      await record(b.svc, { root: ROOT_Y });
      await record(b.svc, { root: ROOT_X, ref: 'b' });
      expect(a.repo.forks[0].root_hex_a).toBe(ROOT_X);
      expect(a.repo.forks[0].root_hex_b).toBe(ROOT_Y);
      expect(b.repo.forks[0].root_hex_a).toBe(ROOT_X);
      expect(b.repo.forks[0].root_hex_b).toBe(ROOT_Y);
    });

    it('fork detection is idempotent — re-recording same observation does not create a new fork row', async () => {
      const { svc, repo } = newSvc();
      await record(svc, { root: ROOT_X });
      await record(svc, { root: ROOT_Y, ref: 'a' });
      await record(svc, { root: ROOT_Y, ref: 'a' });   // re-record same obs
      await record(svc, { root: ROOT_X, ref: 'b' });   // additional obs of same root
      expect(repo.forks.length).toBe(1);
    });

    it('three distinct roots → ONE fork event, fixed at the first detected pair', async () => {
      // After observing (Z, X) — second observation triggers detection
      // with lex-smallest pair (X, Z). After Y arrives later, the first
      // fork event is canonical and additional roots do not overwrite it.
      const { svc, repo } = newSvc();
      await record(svc, { root: ROOT_Z });
      await record(svc, { root: ROOT_X, ref: 'x' });
      await record(svc, { root: ROOT_Y, ref: 'y' });
      expect(repo.forks.length).toBe(1);
      expect(repo.forks[0].root_hex_a).toBe(ROOT_X);
      expect(repo.forks[0].root_hex_b).toBe(ROOT_Z);
    });

    it('different days are independent', async () => {
      const { svc, repo } = newSvc();
      await record(svc, { day: '2026-05-07', root: ROOT_X });
      await record(svc, { day: '2026-05-08', root: ROOT_Y });
      expect(repo.forks.length).toBe(0);
    });

    it('different operators are independent', async () => {
      const { svc } = newSvc();
      await record(svc, { root: ROOT_X });
      // Manually insert observation for different operator
      await svc.recordObservation({
        operator_pubkey: 'b'.repeat(64),
        day_utc: '2026-05-07',
        root_hex: ROOT_Y,
        source: 'manual',
      });
      const forks = await svc.listForks();
      expect(forks.length).toBe(0);
    });
  });

  describe('listForks', () => {
    it('returns most recent first', async () => {
      let now = 1_000_000;
      const repo = new InMemoryRepo();
      const svc = new ForkDetectionService({
        repo: repo as unknown as AepsObserverRepository,
        now: () => now,
      });
      await svc.recordObservation({
        operator_pubkey: OPERATOR,
        day_utc: '2026-05-07',
        root_hex: ROOT_X,
        source: 'self',
      });
      await svc.recordObservation({
        operator_pubkey: OPERATOR,
        day_utc: '2026-05-07',
        root_hex: ROOT_Y,
        source: 'l1',
        source_ref: 'tx1',
      });
      now = 1_000_500;
      await svc.recordObservation({
        operator_pubkey: OPERATOR,
        day_utc: '2026-05-08',
        root_hex: ROOT_X,
        source: 'self',
      });
      await svc.recordObservation({
        operator_pubkey: OPERATOR,
        day_utc: '2026-05-08',
        root_hex: ROOT_Z,
        source: 'l1',
        source_ref: 'tx2',
      });
      const forks = await svc.listForks();
      expect(forks.length).toBe(2);
      expect(forks[0].day_utc).toBe('2026-05-08');
      expect(forks[1].day_utc).toBe('2026-05-07');
    });

    it('filters by operator', async () => {
      const { svc } = newSvc();
      await svc.recordObservation({
        operator_pubkey: OPERATOR,
        day_utc: '2026-05-07',
        root_hex: ROOT_X,
        source: 'self',
      });
      await svc.recordObservation({
        operator_pubkey: OPERATOR,
        day_utc: '2026-05-07',
        root_hex: ROOT_Y,
        source: 'l1',
        source_ref: 't',
      });
      await svc.recordObservation({
        operator_pubkey: 'c'.repeat(64),
        day_utc: '2026-05-07',
        root_hex: ROOT_X,
        source: 'self',
      });
      await svc.recordObservation({
        operator_pubkey: 'c'.repeat(64),
        day_utc: '2026-05-07',
        root_hex: ROOT_Z,
        source: 'l1',
        source_ref: 'u',
      });
      const allForks = await svc.listForks();
      expect(allForks.length).toBe(2);
      const aOnly = await svc.listForks(OPERATOR);
      expect(aOnly.length).toBe(1);
      expect(aOnly[0].operator_pubkey).toBe(OPERATOR);
    });
  });
});
