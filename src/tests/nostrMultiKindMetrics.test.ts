// Phase 8 — C9 : tests d'intégration metrics Prometheus.
// On utilise le stub publisher pour vérifier que les compteurs sont bien
// incrémentés via le scheduler, sans toucher aux relais.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import {
  EndpointStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import { NostrPublishedEventsRepository } from '../repositories/nostrPublishedEventsRepository';
import { NostrMultiKindScheduler } from '../nostr/nostrMultiKindScheduler';
import type { NostrMultiKindPublisher, PublishResult } from '../nostr/nostrMultiKindPublisher';
import type {
  EndpointEndorsementState,
  NodeEndorsementState,
  VerdictFlashState,
} from '../nostr/eventBuilders';
import {
  multiKindFlashesTotal,
  multiKindRepublishSkippedTotal,
  metricsRegistry,
} from '../middleware/metrics';

class StubPublisher {
  private counter = 0;
  async publishEndpointEndorsement(state: EndpointEndorsementState, nowSec: number): Promise<PublishResult> {
    this.counter++;
    return { eventId: this.counter.toString(16).padStart(64, '0'), kind: 30383, publishedAt: nowSec, acks: [{ relay: 'stub', result: 'success' }], anySuccess: true };
  }
  async publishNodeEndorsement(state: NodeEndorsementState, nowSec: number): Promise<PublishResult> {
    this.counter++;
    return { eventId: this.counter.toString(16).padStart(64, '0'), kind: 30382, publishedAt: nowSec, acks: [{ relay: 'stub', result: 'success' }], anySuccess: true };
  }
  async publishVerdictFlash(state: VerdictFlashState, nowSec: number): Promise<PublishResult> {
    this.counter++;
    return { eventId: this.counter.toString(16).padStart(64, '0'), kind: 20900, publishedAt: nowSec, acks: [{ relay: 'stub', result: 'success' }], anySuccess: true };
  }
}

async function metricValue(name: string, labels: Record<string, string> = {}): Promise<number> {
  const json = await metricsRegistry.getMetricsAsJSON();
  const m = json.find((e) => e.name === name);
  if (!m) return 0;
  // Counter/Gauge : values avec labels object.
  const hit = (m.values as Array<{ value: number; labels: Record<string, string> }>).find((v) => {
    for (const [k, val] of Object.entries(labels)) {
      if (v.labels[k] !== val) return false;
    }
    return true;
  });
  return hit?.value ?? 0;
}

describe('Phase 8 C9 — Prometheus metrics wiring', () => {
  let db: Database.Database;
  let endpointStreaming: EndpointStreamingPosteriorRepository;
  let nodeStreaming: NodeStreamingPosteriorRepository;
  let publishedEvents: NostrPublishedEventsRepository;
  let scheduler: NostrMultiKindScheduler;
  let publisher: StubPublisher;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    endpointStreaming = new EndpointStreamingPosteriorRepository(db);
    nodeStreaming = new NodeStreamingPosteriorRepository(db);
    publishedEvents = new NostrPublishedEventsRepository(db);
    publisher = new StubPublisher();
    scheduler = new NostrMultiKindScheduler(
      publisher as unknown as NostrMultiKindPublisher,
      endpointStreaming,
      nodeStreaming,
      publishedEvents,
      null,
      null,
      db,
    );
    // Reset compteurs avant chaque test pour éviter fuite entre cases.
    multiKindFlashesTotal.reset();
    multiKindRepublishSkippedTotal.reset();
  });

  afterEach(() => db.close());

  it('increments republish_skipped_total{reason=no_change} quand rien n\'a changé', async () => {
    const urlHash = 'a'.repeat(64);
    const now = 1_700_000_000;
    for (let i = 0; i < 40; i++) {
      endpointStreaming.ingest(urlHash, 'probe', { successDelta: 1, failureDelta: 0, nowSec: now });
      endpointStreaming.ingest(urlHash, 'report', { successDelta: 1, failureDelta: 0, nowSec: now });
    }
    await scheduler.runScan(now);
    await scheduler.runScan(now + 60);

    const skipped = await metricValue('satrank_nostr_republish_skipped_total', { reason: 'no_change' });
    expect(skipped).toBeGreaterThanOrEqual(1);
  });

  it('increments flashes_total{type=endpoint} sur transition SAFE → RISKY', async () => {
    const urlHash = 'b'.repeat(64);
    const now = 1_700_000_000;
    for (let i = 0; i < 40; i++) {
      endpointStreaming.ingest(urlHash, 'probe', { successDelta: 1, failureDelta: 0, nowSec: now });
      endpointStreaming.ingest(urlHash, 'report', { successDelta: 1, failureDelta: 0, nowSec: now });
    }
    await scheduler.runScan(now);

    const later = now + 3600;
    for (let i = 0; i < 100; i++) {
      endpointStreaming.ingest(urlHash, 'probe', { successDelta: 0, failureDelta: 1, nowSec: later });
    }
    await scheduler.runScan(later);

    const flashesEndpoint = await metricValue('satrank_nostr_flashes_total', { type: 'endpoint' });
    expect(flashesEndpoint).toBe(1);
  });
});
