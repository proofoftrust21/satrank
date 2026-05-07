// AEPS §8.5 (2026-05-07) — Nostr kind 31403 consumer.
//
// Subscribes to AEPS daily anchor events published by other AEPS nodes
// per §8.3 (kind 31403). Each event is a self-attestation by an operator
// "for day D, my Merkle root is R". The consumer :
//
// 1. Verifies the BIP-340 Schnorr signature.
// 2. Extracts (op, day, root) tags + asserts event.pubkey == op tag
//    (operator must publish their own anchor — observer relay forwarding
//    is not authoritative).
// 3. Calls forkDetectionService.recordObservation(source='nostr',
//    source_ref=event.id) — which inserts the row + scans the bucket
//    and emits a fork event when a 2nd distinct root for same (op, day)
//    is now observed.
//
// Combined with AEPS §8.3 publication on our side, this closes the
// federation loop : our anchors flow out to relays, other operators'
// anchors flow in to our observer DB. Fork detection becomes a network-
// wide property without requiring HTTP between nodes.
import { logger } from '../logger';
import type { ForkDetectionService } from '../services/forkDetectionService';
import { NostrEventSubscriber, type NostrEventLike } from './nostrEventSubscriber';
import { DEFAULT_NOSTR_RELAYS } from './relays';

export const KIND_31403 = 31403;

const PUBKEY_RE = /^[0-9a-f]{64}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

type VerifyEvent = (event: NostrEventLike) => boolean;

export interface Kind31403ConsumerOptions {
  forkService: ForkDetectionService;
  /** Schnorr signature verifier. Required ; events fail-closed if invalid. */
  verifyEvent: VerifyEvent;
  relays?: readonly string[];
}

export interface Kind31403Stats {
  eventsReceived: number;
  eventsIgnoredBadSignature: number;
  eventsIgnoredMalformed: number;
  eventsIgnoredAuthorMismatch: number;
  observationsRecorded: number;
  forksDetected: number;
}

function tagValue(tags: string[][], name: string): string | null {
  for (const t of tags) {
    if (Array.isArray(t) && t.length >= 2 && t[0] === name) return t[1];
  }
  return null;
}

export class Kind31403Consumer {
  private subscriber: NostrEventSubscriber;
  private forkService: ForkDetectionService;
  private verifyEvent: VerifyEvent;
  private stats: Kind31403Stats = this.emptyStats();

  constructor(opts: Kind31403ConsumerOptions) {
    this.forkService = opts.forkService;
    this.verifyEvent = opts.verifyEvent;
    const relays = (opts.relays ?? DEFAULT_NOSTR_RELAYS).slice() as string[];
    this.subscriber = new NostrEventSubscriber({
      label: 'kind-31403',
      relays,
      filters: [{ kinds: [KIND_31403] }],
      onEvent: (ev) => this.handleEvent(ev),
    });
  }

  async start(): Promise<void> {
    await this.subscriber.start();
  }

  stop(): void {
    this.subscriber.stop();
  }

  getStats(): Readonly<Kind31403Stats> {
    return { ...this.stats };
  }

  private async handleEvent(event: NostrEventLike): Promise<void> {
    this.stats.eventsReceived += 1;

    if (!this.verifyEvent(event)) {
      this.stats.eventsIgnoredBadSignature += 1;
      return;
    }

    const op = tagValue(event.tags, 'op');
    const day = tagValue(event.tags, 'day');
    const root = tagValue(event.tags, 'root');

    if (!op || !PUBKEY_RE.test(op)) {
      this.stats.eventsIgnoredMalformed += 1;
      return;
    }
    if (!day || !DAY_RE.test(day)) {
      this.stats.eventsIgnoredMalformed += 1;
      return;
    }
    if (!root || !PUBKEY_RE.test(root)) {
      this.stats.eventsIgnoredMalformed += 1;
      return;
    }

    // Operator must publish their own anchor — anyone else relaying it
    // through Nostr does NOT make it authoritative. The signature already
    // proves event.pubkey wrote the event ; the op tag tying it to a
    // declared operator pubkey must match.
    if (event.pubkey.toLowerCase() !== op.toLowerCase()) {
      this.stats.eventsIgnoredAuthorMismatch += 1;
      return;
    }

    try {
      const result = await this.forkService.recordObservation({
        operator_pubkey: op.toLowerCase(),
        day_utc: day,
        root_hex: root.toLowerCase(),
        source: 'nostr',
        source_ref: event.id,
      });
      if (result.status === 'ok') {
        this.stats.observationsRecorded += 1;
        if (result.fork_event) {
          this.stats.forksDetected += 1;
          logger.warn(
            {
              event_id_first8: event.id.slice(0, 8),
              operator_first12: op.slice(0, 12),
              day_utc: day,
              fork_event_id: result.fork_event.fork_event_id,
            },
            'AEPS §8.5: kind 31403 ingestion triggered fork detection',
          );
        }
      } else {
        this.stats.eventsIgnoredMalformed += 1;
      }
    } catch (err) {
      logger.error(
        { event_id: event.id, error: err instanceof Error ? err.message : String(err) },
        'AEPS §8.5: kind 31403 recordObservation threw',
      );
    }
  }

  private emptyStats(): Kind31403Stats {
    return {
      eventsReceived: 0,
      eventsIgnoredBadSignature: 0,
      eventsIgnoredMalformed: 0,
      eventsIgnoredAuthorMismatch: 0,
      observationsRecorded: 0,
      forksDetected: 0,
    };
  }
}
