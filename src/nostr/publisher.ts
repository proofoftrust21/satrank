// Nostr publisher — publishes SatRank scores as NIP-85 kind 30382 events
// Each active Lightning node gets a signed assertion with score, verdict, components, and reachability.
// nostr-tools is ESM-only — all imports are dynamic to work in both tsx (dev) and node CJS (production).
import type { AgentRepository } from '../repositories/agentRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { ScoringService } from '../services/scoringService';
import type { SurvivalService } from '../services/survivalService';
import { logger } from '../logger';
import { VERDICT_SAFE_THRESHOLD } from '../config/scoring';
import {
  nostrPublishTotal,
  nostrRelayAckTotal,
  nostrPublishDuration,
  nostrLastPublishTimestamp,
} from '../middleware/metrics';

const KIND_TRUSTED_ASSERTION = 30382;

// Inter-event delay (ms) between publishes. 300 ms = 3.33 events/sec
// sustained, staying under strfry's anti-spam buckets. Override with
// NOSTR_PUBLISH_INTER_EVENT_MS.
const PUBLISH_INTER_EVENT_MS = Number(process.env.NOSTR_PUBLISH_INTER_EVENT_MS ?? '300');

// Publish timeout per relay per event. Lowered from 5s to 1s: the EVENT
// frame is already on the wire when we call relay.publish() — the ack is
// just confirmation, not a precondition for storage. On rate-limited
// connections the ack can take 4-5s, which was the root cause of 0.21
// events/sec. With 1s timeout we fail fast and move on; the relay still
// stores the event. Replaceable events (NIP-33) guarantee the next cycle
// overwrites anything that was genuinely lost.
const PUBLISH_TIMEOUT_MS = 1_000;

export interface NostrPublisherOptions {
  privateKeyHex: string;
  relays: string[];
  minScore: number;
}

interface ScoreEvent {
  lnPubkey: string;
  alias: string;
  score: number;
  verdict: string;
  reachable: boolean;
  components: Record<string, number>;
  survival: string;
}

// Fingerprint of a published event — used for delta detection. Two events
// with the same fingerprint are semantically identical and don't need to
// be re-published.
function fingerprint(ev: ScoreEvent): string {
  return `${ev.score}|${ev.verdict}|${ev.reachable ? 1 : 0}|${ev.survival}|${ev.components.volume ?? 0}|${ev.components.reputation ?? 0}|${ev.components.seniority ?? 0}|${ev.components.regularity ?? 0}|${ev.components.diversity ?? 0}`;
}

export class NostrPublisher {
  private skHex: string;
  private relays: string[];
  private minScore: number;

  // Delta map: d-tag (ln_pubkey) → fingerprint of the last published event.
  // Populated after each publish cycle. On fresh start (container restart),
  // the map is empty and the first cycle publishes everything — which is the
  // correct behavior for a cold start (the relay might have stale data from
  // a previous era). Subsequent cycles only re-publish events whose
  // fingerprint changed.
  private lastPublished = new Map<string, string>();

  constructor(
    private agentRepo: AgentRepository,
    private probeRepo: ProbeRepository,
    private snapshotRepo: SnapshotRepository,
    private scoringService: ScoringService,
    private survivalService: SurvivalService,
    options: NostrPublisherOptions,
  ) {
    this.skHex = options.privateKeyHex;
    this.relays = options.relays;
    this.minScore = options.minScore;
  }

  async publishScores(): Promise<{ published: number; errors: number; skipped: number; total: number }> {
    // Dynamic imports — nostr-tools is ESM-only, must use import() in CJS runtime
    // @ts-expect-error — moduleResolution "node" can't resolve ESM subpath, works at runtime
    const { finalizeEvent } = await import('nostr-tools/pure');
    // @ts-expect-error — moduleResolution "node" can't resolve ESM subpath, works at runtime
    const { Relay } = await import('nostr-tools/relay');
    const { hexToBytes } = await import('@noble/hashes/utils');
    const sk = hexToBytes(this.skHex);

    const agents = this.agentRepo.findScoredAbove(this.minScore);
    const reachableSet = new Set(
      this.probeRepo ? this.getReachableHashes() : [],
    );

    const allEvents: ScoreEvent[] = [];
    for (const agent of agents) {
      if (!agent.public_key) continue;

      const snap = this.snapshotRepo.findLatestByAgent(agent.public_key_hash);
      if (!snap) continue;

      let components: Record<string, number>;
      try {
        components = JSON.parse(snap.components);
      } catch { continue; }

      const survival = this.survivalService.compute(agent);
      const reachable = reachableSet.has(agent.public_key_hash);

      const verdict = snap.score >= VERDICT_SAFE_THRESHOLD ? 'SAFE' : snap.score >= 30 ? 'UNKNOWN' : 'RISKY';

      allEvents.push({
        lnPubkey: agent.public_key,
        alias: agent.alias ?? agent.public_key.slice(0, 16),
        score: Math.round(snap.score),
        verdict,
        reachable,
        components,
        survival: survival.prediction,
      });
    }

    // Delta filtering: only publish events whose score/verdict/components
    // actually changed since the last cycle. On cold start (empty map),
    // everything is "new" and gets published.
    const isFirstCycle = this.lastPublished.size === 0;
    const toPublish: ScoreEvent[] = [];
    let skipped = 0;

    for (const ev of allEvents) {
      const fp = fingerprint(ev);
      const prev = this.lastPublished.get(ev.lnPubkey);
      if (prev === fp && !isFirstCycle) {
        skipped++;
      } else {
        toPublish.push(ev);
      }
    }

    logger.info(
      {
        total: allEvents.length,
        toPublish: toPublish.length,
        skipped,
        isFirstCycle,
        minScore: this.minScore,
        relays: this.relays,
      },
      'Publishing scores to Nostr (delta mode)',
    );

    if (toPublish.length === 0) {
      logger.info('No score changes since last cycle — nothing to publish');
      return { published: 0, errors: 0, skipped, total: allEvents.length };
    }

    let published = 0;
    let errors = 0;
    const CONNECT_TIMEOUT_MS = 10_000;

    // Connect to relays with timeout — continue with those that work
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connections: { relay: any; url: string }[] = [];
    for (const url of this.relays) {
      try {
        const relay = await Promise.race([
          Relay.connect(url),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), CONNECT_TIMEOUT_MS)),
        ]);
        connections.push({ relay, url });
        logger.info({ relay: url }, 'Nostr relay connected');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ relay: url, error: msg }, 'Nostr relay connection failed — skipping');
      }
    }

    if (connections.length === 0) {
      logger.error('No Nostr relays connected — aborting publish');
      return { published: 0, errors: toPublish.length, skipped, total: allEvents.length };
    }

    logger.info({ connected: connections.length, total: this.relays.length }, 'Nostr relay connections established');

    const cycleStartMs = Date.now();
    for (const ev of toPublish) {
      try {
        const template = {
          kind: KIND_TRUSTED_ASSERTION,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['d', ev.lnPubkey],
            ['n', 'lightning'],
            ['rank', String(ev.score)],
            ['alias', ev.alias],
            ['score', String(ev.score)],
            ['verdict', ev.verdict],
            ['reachable', ev.reachable ? 'true' : 'false'],
            ['survival', ev.survival],
            ['volume', String(ev.components.volume ?? 0)],
            ['reputation', String(ev.components.reputation ?? 0)],
            ['seniority', String(ev.components.seniority ?? 0)],
            ['regularity', String(ev.components.regularity ?? 0)],
            ['diversity', String(ev.components.diversity ?? 0)],
          ],
          content: '',
        };

        const signed = finalizeEvent(template, sk);

        // Publish to all connected relays in parallel with short timeout.
        // The EVENT frame is on the wire before the ack — timeout just means
        // we don't wait for the relay's OK confirmation, not that the event
        // wasn't stored. Fire-fast, not fire-and-forget.
        await Promise.allSettled(
          connections.map(async ({ relay, url }) => {
            try {
              await Promise.race([
                relay.publish(signed),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Publish timeout')), PUBLISH_TIMEOUT_MS)),
              ]);
              nostrRelayAckTotal.inc({ relay: url, result: 'success' });
            } catch (err: unknown) {
              // Timeouts are a distinct signal from protocol errors: the first
              // means the relay is slow, the second means it rejected the
              // event or the socket dropped. Both are non-fatal (we move on)
              // but the metric preserves the distinction for diagnosis.
              const result = err instanceof Error && err.message === 'Publish timeout' ? 'timeout' : 'error';
              nostrRelayAckTotal.inc({ relay: url, result });
            }
          }),
        );

        published++;
        nostrPublishTotal.inc({ stream: 'A', result: 'published' });

        // Update the delta map so the next cycle skips this d-tag if unchanged
        this.lastPublished.set(ev.lnPubkey, fingerprint(ev));

        // Sustained inter-event delay
        if (published < toPublish.length && PUBLISH_INTER_EVENT_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, PUBLISH_INTER_EVENT_MS));
        }

        // Progress log every 200 events (more frequent now that batches are smaller)
        if (published % 200 === 0) {
          const elapsedSec = (Date.now() - cycleStartMs) / 1000;
          const rate = published / Math.max(elapsedSec, 0.001);
          logger.info(
            { published, total: toPublish.length, elapsedSec: Math.round(elapsedSec), eventsPerSec: rate.toFixed(2) },
            'Nostr publish progress',
          );
        }
      } catch (err: unknown) {
        errors++;
        nostrPublishTotal.inc({ stream: 'A', result: 'error' });
        if (errors <= 5) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ lnPubkey: ev.lnPubkey.slice(0, 12), error: msg }, 'Failed to sign/publish Nostr event');
        }
      }
    }

    // Also update the delta map for events that were SKIPPED (their
    // fingerprint hasn't changed, but we need them in the map so a fresh
    // cycle after restart knows they exist). On cold start the map was
    // empty, so this loop populates it for the first time.
    for (const ev of allEvents) {
      if (!this.lastPublished.has(ev.lnPubkey)) {
        this.lastPublished.set(ev.lnPubkey, fingerprint(ev));
      }
    }

    // Close connections
    for (const { relay, url } of connections) {
      try { relay.close(); } catch { logger.warn({ relay: url }, 'Failed to close relay connection'); }
    }

    // Skipped events (unchanged fingerprint) are useful to track: a cycle
    // that suddenly publishes everything (skipped drops to 0) can signal
    // a delta-map wipe or a scoring regression that changed every agent.
    if (skipped > 0) nostrPublishTotal.inc({ stream: 'A', result: 'skipped' }, skipped);
    nostrPublishDuration.observe({ stream: 'A' }, (Date.now() - cycleStartMs) / 1000);
    if (published > 0) nostrLastPublishTimestamp.set({ stream: 'A' }, Math.floor(Date.now() / 1000));

    logger.info(
      { published, errors, skipped, total: allEvents.length, relays: connections.length },
      'Nostr score publish complete',
    );
    return { published, errors, skipped, total: allEvents.length };
  }

  private getReachableHashes(): string[] {
    const agents = this.agentRepo.findLightningAgentsWithPubkey();
    const reachable: string[] = [];
    for (const agent of agents) {
      const uptime = this.probeRepo.computeUptime(agent.public_key_hash, 7 * 86400);
      if (uptime !== null && uptime > 0) {
        reachable.push(agent.public_key_hash);
      }
    }
    return reachable;
  }
}
