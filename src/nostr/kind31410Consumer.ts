// AEPS §8.5 (2026-05-08) — Nostr kind 31410 fork-event consumer.
//
// Subscribes to kind 31410 fork events published by other AEPS observers
// per the §8.5 publication. Each event is a third-party attestation
// "for operator X day D, root_a ≠ root_b". The consumer translates the
// event into TWO local observations (one per root, source='nostr',
// source_ref=event.id), and our own ForkDetectionService.recordObservation
// cascade emits a local fork_event linking to OUR observation IDs. The
// fork is now both publicly attested (peer's event) and locally
// enforceable (our claim).
//
// Why two recordObservation calls instead of a direct fork insertion :
// our schema's aeps_fork_events references aeps_observed_anchors.id values.
// A peer's fork event references their own observation IDs which don't
// exist in our DB. By recording the two roots as observations and letting
// our normal cascade emit the fork, the foreign keys stay valid and the
// detection logic is unified — no special "imported fork" code path.
//
// Authorship : the kind 31410 publisher is the OBSERVER, not the
// equivocating operator. So event.pubkey can be any pubkey ; we don't
// reject on authorship. The signature merely proves the publisher is
// not a relay forwarding a forged event.
import { logger } from '../logger';
import type { ForkDetectionService } from '../services/forkDetectionService';
import { NostrEventSubscriber, type NostrEventLike } from './nostrEventSubscriber';
import { DEFAULT_NOSTR_RELAYS } from './relays';

export const KIND_31410 = 31410;

const PUBKEY_RE = /^[0-9a-f]{64}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

type VerifyEvent = (event: NostrEventLike) => boolean;

export interface Kind31410ConsumerOptions {
  forkService: ForkDetectionService;
  verifyEvent: VerifyEvent;
  relays?: readonly string[];
}

export interface Kind31410Stats {
  eventsReceived: number;
  eventsIgnoredBadSignature: number;
  eventsIgnoredMalformed: number;
  eventsIgnoredEqualRoots: number;
  observationsRecorded: number;  // 0, 1, or 2 per event
  forksDetectedLocally: number;
}

function tagValue(tags: string[][], name: string): string | null {
  for (const t of tags) {
    if (Array.isArray(t) && t.length >= 2 && t[0] === name) return t[1];
  }
  return null;
}

export class Kind31410Consumer {
  private subscriber: NostrEventSubscriber;
  private forkService: ForkDetectionService;
  private verifyEvent: VerifyEvent;
  private stats: Kind31410Stats = this.emptyStats();

  constructor(opts: Kind31410ConsumerOptions) {
    this.forkService = opts.forkService;
    this.verifyEvent = opts.verifyEvent;
    const relays = (opts.relays ?? DEFAULT_NOSTR_RELAYS).slice() as string[];
    this.subscriber = new NostrEventSubscriber({
      label: 'kind-31410',
      relays,
      filters: [{ kinds: [KIND_31410] }],
      onEvent: (ev) => this.handleEvent(ev),
    });
  }

  async start(): Promise<void> {
    await this.subscriber.start();
  }

  stop(): void {
    this.subscriber.stop();
  }

  getStats(): Readonly<Kind31410Stats> {
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
    const rootA = tagValue(event.tags, 'root_a');
    const rootB = tagValue(event.tags, 'root_b');

    if (!op || !PUBKEY_RE.test(op)) {
      this.stats.eventsIgnoredMalformed += 1;
      return;
    }
    if (!day || !DAY_RE.test(day)) {
      this.stats.eventsIgnoredMalformed += 1;
      return;
    }
    if (!rootA || !PUBKEY_RE.test(rootA)) {
      this.stats.eventsIgnoredMalformed += 1;
      return;
    }
    if (!rootB || !PUBKEY_RE.test(rootB)) {
      this.stats.eventsIgnoredMalformed += 1;
      return;
    }
    if (rootA.toLowerCase() === rootB.toLowerCase()) {
      // A fork event with equal roots is malformed — not a fork.
      this.stats.eventsIgnoredEqualRoots += 1;
      return;
    }

    // Record both roots as observations. Source='nostr', source_ref=event.id.
    // The cascade in our ForkDetectionService.recordObservation will emit a
    // local fork_event linking to OUR observation IDs.
    let firstFork = false;
    for (const root of [rootA.toLowerCase(), rootB.toLowerCase()]) {
      try {
        const result = await this.forkService.recordObservation({
          operator_pubkey: op.toLowerCase(),
          day_utc: day,
          root_hex: root,
          source: 'nostr',
          source_ref: event.id,
        });
        if (result.status === 'ok') {
          this.stats.observationsRecorded += 1;
          if (result.fork_event && !firstFork) {
            this.stats.forksDetectedLocally += 1;
            firstFork = true;
          }
        }
      } catch (err) {
        logger.error(
          {
            event_id: event.id,
            root_first8: root.slice(0, 8),
            error: err instanceof Error ? err.message : String(err),
          },
          'AEPS §8.5: kind 31410 recordObservation threw',
        );
      }
    }

    if (firstFork) {
      logger.warn(
        {
          event_id_first8: event.id.slice(0, 8),
          operator_first12: op.slice(0, 12),
          day_utc: day,
        },
        'AEPS §8.5: kind 31410 ingestion triggered local fork detection',
      );
    }
  }

  private emptyStats(): Kind31410Stats {
    return {
      eventsReceived: 0,
      eventsIgnoredBadSignature: 0,
      eventsIgnoredMalformed: 0,
      eventsIgnoredEqualRoots: 0,
      observationsRecorded: 0,
      forksDetectedLocally: 0,
    };
  }
}
