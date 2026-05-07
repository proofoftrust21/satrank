// AEPS §8.5 — kind 31410 fork-event consumer parser tests.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  ForkDetectionService,
  RecordObservationInput,
  RecordObservationResult,
} from '../services/forkDetectionService';

const lastSubRef: { current: { onEvent: (ev: unknown) => Promise<void> | void } | null } = { current: null };

vi.mock('../nostr/nostrEventSubscriber', () => {
  return {
    NostrEventSubscriber: class {
      onEvent: (ev: unknown) => Promise<void> | void;
      constructor(opts: { onEvent: (ev: unknown) => Promise<void> | void }) {
        this.onEvent = opts.onEvent;
        lastSubRef.current = this;
      }
      async start() {}
      stop() {}
    },
  };
});

import { Kind31410Consumer, KIND_31410 } from '../nostr/kind31410Consumer';

interface FakeEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

const OPERATOR = 'aa'.repeat(32);
const ROOT_A = '11'.repeat(32);
const ROOT_B = '22'.repeat(32);
const OBSERVER_PK = 'cc'.repeat(32);

function fakeEvent(overrides: Partial<FakeEvent> = {}): FakeEvent {
  return {
    id: 'ee'.repeat(32),
    pubkey: OBSERVER_PK,  // anyone can be the observer
    kind: KIND_31410,
    created_at: 1714759200,
    tags: [
      ['d', `${OPERATOR}:2026-05-07`],
      ['t', 'aeps-fork'],
      ['op', OPERATOR],
      ['day', '2026-05-07'],
      ['root_a', ROOT_A],
      ['root_b', ROOT_B],
      ['fork_event_id', '7'],
    ],
    content: '',
    sig: 'aa'.repeat(64),
    ...overrides,
  };
}

class StubForkService {
  observations: RecordObservationInput[] = [];
  shouldForkOnSecond = false;

  async recordObservation(input: RecordObservationInput): Promise<RecordObservationResult> {
    this.observations.push(input);
    const isSecond = this.observations.length === 2;
    return {
      status: 'ok',
      observation: {
        observation_id: this.observations.length,
        operator_pubkey: input.operator_pubkey,
        day_utc: input.day_utc,
        root_hex: input.root_hex,
        source: input.source,
        source_ref: input.source_ref ?? null,
        observed_at: 1714759200,
      },
      fork_event: isSecond && this.shouldForkOnSecond
        ? {
            fork_event_id: 1,
            operator_pubkey: input.operator_pubkey,
            day_utc: input.day_utc,
            root_hex_a: ROOT_A,
            root_hex_b: ROOT_B,
            observation_id_a: 1,
            observation_id_b: 2,
            detected_at: 1714759200,
            nostr_event_id: null,
            nostr_published_at: null,
            claim_id: null,
          }
        : null,
    };
  }

  async detectFork() { return null; }
  async listForks() { return []; }
}

function newConsumer(verifyResult = true) {
  const fork = new StubForkService();
  const verifyEvent = vi.fn(() => verifyResult);
  const consumer = new Kind31410Consumer({
    forkService: fork as unknown as ForkDetectionService,
    verifyEvent,
  });
  if (!lastSubRef.current) throw new Error('subscriber stub not captured');
  return { consumer, fork, verifyEvent, sub: lastSubRef.current };
}

beforeEach(() => {
  lastSubRef.current = null;
});

describe('AEPS §8.5 — Kind 31410 fork consumer', () => {
  it('records BOTH roots as observations on a valid event', async () => {
    const { fork, sub } = newConsumer(true);
    await sub.onEvent(fakeEvent());
    expect(fork.observations.length).toBe(2);
    expect(fork.observations[0].operator_pubkey).toBe(OPERATOR);
    expect(fork.observations[0].day_utc).toBe('2026-05-07');
    expect(fork.observations[0].root_hex).toBe(ROOT_A);
    expect(fork.observations[1].root_hex).toBe(ROOT_B);
    expect(fork.observations[0].source).toBe('nostr');
    expect(fork.observations[0].source_ref).toBe('ee'.repeat(32));
  });

  it('rejects events with bad signature', async () => {
    const { fork, sub, consumer } = newConsumer(false);
    await sub.onEvent(fakeEvent());
    expect(fork.observations.length).toBe(0);
    expect(consumer.getStats().eventsIgnoredBadSignature).toBe(1);
  });

  it('does NOT enforce event.pubkey == op (observer ≠ operator by design)', async () => {
    const { fork, sub } = newConsumer(true);
    // Use a totally different pubkey for event.pubkey — observer publishes
    await sub.onEvent(fakeEvent({ pubkey: 'ff'.repeat(32) }));
    expect(fork.observations.length).toBe(2);
  });

  it('rejects malformed op tag', async () => {
    const { fork, sub, consumer } = newConsumer(true);
    await sub.onEvent(fakeEvent({
      tags: [
        ['op', 'not-hex'],
        ['day', '2026-05-07'],
        ['root_a', ROOT_A],
        ['root_b', ROOT_B],
      ],
    }));
    expect(fork.observations.length).toBe(0);
    expect(consumer.getStats().eventsIgnoredMalformed).toBe(1);
  });

  it('rejects fork event with equal roots (not a fork)', async () => {
    const { fork, sub, consumer } = newConsumer(true);
    await sub.onEvent(fakeEvent({
      tags: [
        ['op', OPERATOR],
        ['day', '2026-05-07'],
        ['root_a', ROOT_A],
        ['root_b', ROOT_A],   // equal
      ],
    }));
    expect(fork.observations.length).toBe(0);
    expect(consumer.getStats().eventsIgnoredEqualRoots).toBe(1);
  });

  it('rejects malformed root_b', async () => {
    const { fork, sub, consumer } = newConsumer(true);
    await sub.onEvent(fakeEvent({
      tags: [
        ['op', OPERATOR],
        ['day', '2026-05-07'],
        ['root_a', ROOT_A],
        ['root_b', 'too-short'],
      ],
    }));
    expect(fork.observations.length).toBe(0);
    expect(consumer.getStats().eventsIgnoredMalformed).toBe(1);
  });

  it('counts forksDetectedLocally when 2nd observation triggers detection', async () => {
    const { fork, sub, consumer } = newConsumer(true);
    fork.shouldForkOnSecond = true;
    await sub.onEvent(fakeEvent());
    expect(consumer.getStats().forksDetectedLocally).toBe(1);
    expect(consumer.getStats().observationsRecorded).toBe(2);
  });

  it('case-normalizes op + roots to lowercase', async () => {
    const { fork, sub } = newConsumer(true);
    await sub.onEvent(fakeEvent({
      tags: [
        ['op', OPERATOR.toUpperCase()],
        ['day', '2026-05-07'],
        ['root_a', ROOT_A.toUpperCase()],
        ['root_b', ROOT_B.toUpperCase()],
      ],
    }));
    expect(fork.observations[0].operator_pubkey).toBe(OPERATOR);
    expect(fork.observations[0].root_hex).toBe(ROOT_A);
    expect(fork.observations[1].root_hex).toBe(ROOT_B);
  });
});
