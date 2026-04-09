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
  private skHex: string;
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
    this.skHex = options.privateKeyHex;
    this.relays = options.relays;
    this.minScore = options.minScore;
  }

  async publishScores(): Promise<{ published: number; errors: number }> {
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

      const verdict = snap.score >= VERDICT_SAFE_THRESHOLD ? 'SAFE' : snap.score >= 30 ? 'UNKNOWN' : 'RISKY';

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

    logger.info({ count: events.length, minScore: this.minScore, relays: this.relays }, 'Publishing scores to Nostr');

    let published = 0;
    let errors = 0;
    const CONNECT_TIMEOUT_MS = 10_000;
    const PUBLISH_TIMEOUT_MS = 5_000;

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
      return { published: 0, errors: events.length };
    }

    logger.info({ connected: connections.length, total: this.relays.length }, 'Nostr relay connections established');

    // Publish events with throttle (20/sec to avoid relay rate limits)
    for (const ev of events) {
      try {
        const template = {
          kind: KIND_TRUSTED_ASSERTION,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['d', ev.lnPubkey],
            ['n', 'lightning'],
            // 'rank' is the NIP-85 canonical tag for a normalized 0-100 trust
            // score — published alongside the SatRank-specific 'score' tag so
            // strict NIP-85 consumers can consume assertions without needing
            // SatRank-specific knowledge.
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

        // Publish to all connected relays in parallel with timeout
        await Promise.allSettled(
          connections.map(({ relay }) =>
            Promise.race([
              relay.publish(signed),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Publish timeout')), PUBLISH_TIMEOUT_MS)),
            ]).catch(() => { /* individual relay failures are non-fatal */ }),
          ),
        );

        published++;

        // Throttle: 20 events/sec
        if (published % 20 === 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Progress log every 500 events
        if (published % 500 === 0) {
          logger.info({ published, total: events.length }, 'Nostr publish progress');
        }
      } catch (err: unknown) {
        errors++;
        if (errors <= 5) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ lnPubkey: ev.lnPubkey.slice(0, 12), error: msg }, 'Failed to sign/publish Nostr event');
        }
      }
    }

    // Close connections
    for (const { relay, url } of connections) {
      try { relay.close(); } catch { logger.warn({ relay: url }, 'Failed to close relay connection'); }
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
