// Nostr publisher — publishes SatRank scores as NIP-85 kind 30382 events
// Each active Lightning node gets a signed assertion with score, verdict, components, and reachability.
// Agents and wallets can subscribe to these events to make trust decisions without the API.
// nostr-tools uses ESM subpath exports — tsx handles this at runtime,
// but tsc with moduleResolution "node" can't resolve the types.
// @ts-expect-error — runtime import works via tsx
import { finalizeEvent, type EventTemplate } from 'nostr-tools/pure';
// @ts-expect-error — runtime import works via tsx
import { Relay } from 'nostr-tools/relay';
import { hexToBytes } from '@noble/hashes/utils';
import type { AgentRepository } from '../repositories/agentRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { ScoringService } from '../services/scoringService';
import type { SurvivalService } from '../services/survivalService';
import { logger } from '../logger';

const KIND_TRUSTED_ASSERTION = 30382;

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

export class NostrPublisher {
  private sk: Uint8Array;
  private relays: string[];
  private minScore: number;

  constructor(
    private agentRepo: AgentRepository,
    private probeRepo: ProbeRepository,
    private snapshotRepo: SnapshotRepository,
    private scoringService: ScoringService,
    private survivalService: SurvivalService,
    options: NostrPublisherOptions,
  ) {
    this.sk = hexToBytes(options.privateKeyHex);
    this.relays = options.relays;
    this.minScore = options.minScore;
  }

  async publishScores(): Promise<{ published: number; errors: number }> {
    const agents = this.agentRepo.findScoredAbove(this.minScore);
    const reachableSet = new Set(
      this.probeRepo ? this.getReachableHashes() : [],
    );

    const events: ScoreEvent[] = [];
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

      const verdict = snap.score >= 50 ? 'SAFE' : snap.score >= 30 ? 'UNKNOWN' : 'RISKY';

      events.push({
        lnPubkey: agent.public_key,
        alias: agent.alias ?? agent.public_key.slice(0, 16),
        score: Math.round(snap.score),
        verdict,
        reachable,
        components,
        survival: survival.prediction,
      });
    }

    logger.info({ count: events.length, minScore: this.minScore }, 'Publishing scores to Nostr');

    let published = 0;
    let errors = 0;

    // Connect to relays
    const connections: Relay[] = [];
    for (const url of this.relays) {
      try {
        const relay = await Relay.connect(url);
        connections.push(relay);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ relay: url, error: msg }, 'Failed to connect to Nostr relay');
        errors++;
      }
    }

    if (connections.length === 0) {
      logger.error('No Nostr relays connected — aborting publish');
      return { published: 0, errors: events.length };
    }

    // Publish events with throttle (20/sec to avoid relay rate limits)
    for (const ev of events) {
      try {
        const template: EventTemplate = {
          kind: KIND_TRUSTED_ASSERTION,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['d', ev.lnPubkey],
            ['n', 'lightning'],
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

        const signed = finalizeEvent(template, this.sk);

        for (const relay of connections) {
          try {
            await relay.publish(signed);
          } catch {
            // Individual relay publish failures are non-fatal
          }
        }

        published++;

        // Throttle: 20 events/sec
        if (published % 20 === 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (err: unknown) {
        errors++;
        if (errors <= 5) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ lnPubkey: ev.lnPubkey.slice(0, 12), error: msg }, 'Failed to publish Nostr event');
        }
      }
    }

    // Close connections
    for (const relay of connections) {
      try { relay.close(); } catch { /* ignore */ }
    }

    logger.info({ published, errors, relays: connections.length }, 'Nostr score publish complete');
    return { published, errors };
  }

  private getReachableHashes(): string[] {
    // Get all hashes that have at least one reachable probe
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
