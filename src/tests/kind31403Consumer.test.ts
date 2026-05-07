// AEPS §8.5 — Kind 31403 consumer parser tests with stubbed verifier.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ForkDetectionService, RecordObservationInput, RecordObservationResult } from '../services/forkDetectionService';

const lastSubRef: { current: { onEvent: (ev: unknown) => Promise<void> | void } | null } = { current: null };

// Stub the NostrEventSubscriber so the consumer is testable without a relay.
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

import { Kind31403Consumer, KIND_31403 } from '../nostr/kind31403Consumer';

interface FakeEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

const OPERATOR_A = 'aa'.repeat(32);
const OPERATOR_B = 'bb'.repeat(32);
const ROOT_X = '11'.repeat(32);
const ROOT_Y = '22'.repeat(32);

function fakeEvent(overrides: Partial<FakeEvent> = {}): FakeEvent {
  return {
    id: 'ee'.repeat(32),
    pubkey: OPERATOR_A,
    kind: KIND_31403,
    created_at: 1714759200,
    tags: [
      ['d', `${OPERATOR_A}:2026-05-07`],
      ['t', 'aeps-anchor'],
      ['op', OPERATOR_A],
      ['day', '2026-05-07'],
      ['root', ROOT_X],
      ['receipts', '42'],
    ],
    content: '',
    sig: 'aa'.repeat(64),
    ...overrides,
  };
}

class StubForkService {
  observations: RecordObservationInput[] = [];
  // Simulate the second observation triggering a fork.
  shouldFork = false;

  async recordObservation(input: RecordObservationInput): Promise<RecordObservationResult> {
    this.observations.push(input);
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
      fork_event: this.shouldFork
        ? {
            fork_event_id: 1,
            operator_pubkey: input.operator_pubkey,
            day_utc: input.day_utc,
            root_hex_a: ROOT_X,
            root_hex_b: ROOT_Y,
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
  const consumer = new Kind31403Consumer({
    forkService: fork as unknown as ForkDetectionService,
    verifyEvent,
  });
  if (!lastSubRef.current) throw new Error('subscriber stub not captured');
  return { consumer, fork, verifyEvent, sub: lastSubRef.current };
}

beforeEach(() => {
  lastSubRef.current = null;
});

describe('AEPS §8.5 — Kind 31403 consumer', () => {
  it('records observation for a valid signed event', async () => {
    const { fork, sub, consumer } = newConsumer(true);
    await sub.onEvent(fakeEvent());
    expect(fork.observations.length).toBe(1);
    expect(fork.observations[0].operator_pubkey).toBe(OPERATOR_A);
    expect(fork.observations[0].day_utc).toBe('2026-05-07');
    expect(fork.observations[0].root_hex).toBe(ROOT_X);
    expect(fork.observations[0].source).toBe('nostr');
    expect(fork.observations[0].source_ref).toBe('ee'.repeat(32));
    const stats = consumer.getStats();
    expect(stats.observationsRecorded).toBe(1);
  });

  it('rejects events with bad signature (verifier returns false)', async () => {
    const { fork, sub, consumer } = newConsumer(false);
    await sub.onEvent(fakeEvent());
    expect(fork.observations.length).toBe(0);
    expect(consumer.getStats().eventsIgnoredBadSignature).toBe(1);
  });

  it('rejects events where event.pubkey != op tag (relay forwarding fraud)', async () => {
    const { fork, sub, consumer } = newConsumer(true);
    await sub.onEvent(fakeEvent({ pubkey: OPERATOR_B }));
    expect(fork.observations.length).toBe(0);
    expect(consumer.getStats().eventsIgnoredAuthorMismatch).toBe(1);
  });

  it('rejects malformed op tag', async () => {
    const { fork, sub, consumer } = newConsumer(true);
    await sub.onEvent(fakeEvent({
      tags: [
        ['op', 'not-hex'],
        ['day', '2026-05-07'],
        ['root', ROOT_X],
      ],
    }));
    expect(fork.observations.length).toBe(0);
    expect(consumer.getStats().eventsIgnoredMalformed).toBe(1);
  });

  it('rejects malformed day tag', async () => {
    const { fork, sub, consumer } = newConsumer(true);
    await sub.onEvent(fakeEvent({
      tags: [
        ['op', OPERATOR_A],
        ['day', '2026-5-7'],
        ['root', ROOT_X],
      ],
    }));
    expect(fork.observations.length).toBe(0);
    expect(consumer.getStats().eventsIgnoredMalformed).toBe(1);
  });

  it('rejects malformed root tag', async () => {
    const { fork, sub, consumer } = newConsumer(true);
    await sub.onEvent(fakeEvent({
      tags: [
        ['op', OPERATOR_A],
        ['day', '2026-05-07'],
        ['root', 'too-short'],
      ],
    }));
    expect(fork.observations.length).toBe(0);
    expect(consumer.getStats().eventsIgnoredMalformed).toBe(1);
  });

  it('counts forks when recordObservation triggers detection', async () => {
    const { fork, sub, consumer } = newConsumer(true);
    fork.shouldFork = true;
    await sub.onEvent(fakeEvent());
    expect(consumer.getStats().forksDetected).toBe(1);
    expect(consumer.getStats().observationsRecorded).toBe(1);
  });

  it('case-normalizes op + root to lowercase', async () => {
    const { fork, sub } = newConsumer(true);
    await sub.onEvent(fakeEvent({
      pubkey: OPERATOR_A.toUpperCase(),
      tags: [
        ['op', OPERATOR_A.toUpperCase()],
        ['day', '2026-05-07'],
        ['root', ROOT_X.toUpperCase()],
      ],
    }));
    expect(fork.observations[0].operator_pubkey).toBe(OPERATOR_A);
    expect(fork.observations[0].root_hex).toBe(ROOT_X);
  });
});
