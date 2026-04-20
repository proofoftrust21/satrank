// Phase 8 — C5 : tests d'intégration du NostrMultiKindScheduler.
// Utilise un stub publisher (pas de réseau, ack instantané) et une DB in-mem.
// Vérifie les 4 scénarios critiques du cron :
//   1. first_publish : entité avec posteriors mais pas dans cache → publié.
//   2. skip no-change : snapshot identique au last_published → pas republié.
//   3. republish on verdict change : injection d'observations qui basculent
//      le verdict → publié à nouveau + cache mis à jour.
//   4. error isolation : publisher qui échoue ponctuellement n'interrompt pas
//      le scan, les autres entités passent.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import {
  EndpointStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import { NostrPublishedEventsRepository } from '../repositories/nostrPublishedEventsRepository';
import { NostrMultiKindScheduler } from '../nostr/nostrMultiKindScheduler';
import type {
  NostrMultiKindPublisher,
  PublishResult,
} from '../nostr/nostrMultiKindPublisher';
import type {
  EndpointEndorsementState,
  NodeEndorsementState,
  VerdictFlashState,
} from '../nostr/eventBuilders';
import { isVerdictTransition } from '../nostr/nostrMultiKindScheduler';

interface PublishCall {
  kind: number;
  entityId: string;
}

interface FlashCall {
  entityType: 'node' | 'endpoint' | 'service';
  entityId: string;
  fromVerdict: string | null;
  toVerdict: string;
}

/** Stub publisher : ne touche pas au réseau, renvoie toujours un ack success
 *  unless nextShouldFail est true, auquel cas il renvoie anySuccess=false. */
class StubPublisher {
  calls: PublishCall[] = [];
  flashCalls: FlashCall[] = [];
  nextShouldFail = false;
  nextFlashShouldFail = false;
  private eventCounter = 0;

  private nextEventId(): string {
    this.eventCounter++;
    return this.eventCounter.toString(16).padStart(64, '0');
  }

  async publishEndpointEndorsement(
    state: EndpointEndorsementState,
    nowSec: number,
  ): Promise<PublishResult> {
    const fail = this.nextShouldFail;
    this.nextShouldFail = false;
    this.calls.push({ kind: 30383, entityId: state.url_hash });
    return {
      eventId: this.nextEventId(),
      kind: 30383,
      publishedAt: nowSec,
      acks: [{ relay: 'wss://stub', result: fail ? 'error' : 'success' }],
      anySuccess: !fail,
    };
  }

  async publishNodeEndorsement(
    state: NodeEndorsementState,
    nowSec: number,
  ): Promise<PublishResult> {
    const fail = this.nextShouldFail;
    this.nextShouldFail = false;
    this.calls.push({ kind: 30382, entityId: state.node_pubkey });
    return {
      eventId: this.nextEventId(),
      kind: 30382,
      publishedAt: nowSec,
      acks: [{ relay: 'wss://stub', result: fail ? 'error' : 'success' }],
      anySuccess: !fail,
    };
  }

  async publishVerdictFlash(
    state: VerdictFlashState,
    nowSec: number,
  ): Promise<PublishResult> {
    const fail = this.nextFlashShouldFail;
    this.nextFlashShouldFail = false;
    this.flashCalls.push({
      entityType: state.entity_type,
      entityId: state.entity_id,
      fromVerdict: state.from_verdict,
      toVerdict: state.to_verdict,
    });
    return {
      eventId: this.nextEventId(),
      kind: 20900,
      publishedAt: nowSec,
      acks: [{ relay: 'wss://stub', result: fail ? 'error' : 'success' }],
      anySuccess: !fail,
    };
  }

  async close(): Promise<void> {}
}

function makeScheduler(db: Database.Database) {
  const endpointStreaming = new EndpointStreamingPosteriorRepository(db);
  const nodeStreaming = new NodeStreamingPosteriorRepository(db);
  const publishedEvents = new NostrPublishedEventsRepository(db);
  const publisher = new StubPublisher();
  const scheduler = new NostrMultiKindScheduler(
    publisher as unknown as NostrMultiKindPublisher,
    endpointStreaming,
    nodeStreaming,
    publishedEvents,
    null,
    null,
    db,
  );
  return { scheduler, publisher, endpointStreaming, nodeStreaming, publishedEvents };
}

/** Pousse un batch d'observations probe biaisées SAFE (succès dominants). */
function seedSafeEndpoint(
  repo: EndpointStreamingPosteriorRepository,
  urlHash: string,
  nowSec: number,
): void {
  for (let i = 0; i < 25; i++) {
    repo.ingest(urlHash, 'probe', { successDelta: 1, failureDelta: 0, nowSec });
  }
  for (let i = 0; i < 25; i++) {
    repo.ingest(urlHash, 'report', { successDelta: 1, failureDelta: 0, nowSec });
  }
}

/** Pousse un batch biaisé RISKY (échecs dominants). */
function seedRiskyEndpoint(
  repo: EndpointStreamingPosteriorRepository,
  urlHash: string,
  nowSec: number,
): void {
  for (let i = 0; i < 50; i++) {
    repo.ingest(urlHash, 'probe', { successDelta: 0, failureDelta: 1, nowSec });
  }
}

describe('NostrMultiKindScheduler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => db.close());

  it('first_publish : entité modifiée, pas de cache → publie + record', async () => {
    const { scheduler, publisher, endpointStreaming, publishedEvents } = makeScheduler(db);
    const urlHash = 'a'.repeat(64);
    const now = 1_000_000;
    seedSafeEndpoint(endpointStreaming, urlHash, now);

    const result = await scheduler.runScan(now);
    const endpointRes = result.perType.find((p) => p.entityType === 'endpoint')!;

    expect(endpointRes.scanned).toBe(1);
    expect(endpointRes.published).toBe(1);
    expect(endpointRes.firstPublish).toBe(1);
    expect(endpointRes.skippedNoChange).toBe(0);
    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0].kind).toBe(30383);

    const cached = publishedEvents.getLastPublished('endpoint', urlHash);
    expect(cached).not.toBeNull();
    expect(cached!.event_kind).toBe(30383);
  });

  it('no-change : deuxième scan avec posteriors inchangés → skip', async () => {
    const { scheduler, publisher, endpointStreaming } = makeScheduler(db);
    const urlHash = 'b'.repeat(64);
    const now = 1_000_000;
    seedSafeEndpoint(endpointStreaming, urlHash, now);

    await scheduler.runScan(now);
    publisher.calls.length = 0; // reset

    // Second scan une minute plus tard — rien de nouveau dans les posteriors.
    const result2 = await scheduler.runScan(now + 60);
    const endpointRes = result2.perType.find((p) => p.entityType === 'endpoint')!;

    expect(endpointRes.published).toBe(0);
    expect(endpointRes.skippedNoChange).toBe(1);
    expect(publisher.calls).toHaveLength(0);
  });

  it('republish : verdict change après injection d\'échecs → republie', async () => {
    const { scheduler, publisher, endpointStreaming } = makeScheduler(db);
    const urlHash = 'c'.repeat(64);
    const now = 1_000_000;

    seedSafeEndpoint(endpointStreaming, urlHash, now);
    await scheduler.runScan(now);
    const firstCallCount = publisher.calls.length;
    expect(firstCallCount).toBe(1);

    // 1h plus tard, inonde d'échecs pour faire passer en RISKY.
    const later = now + 3600;
    for (let i = 0; i < 80; i++) {
      endpointStreaming.ingest(urlHash, 'probe', { successDelta: 0, failureDelta: 1, nowSec: later });
    }

    const result2 = await scheduler.runScan(later);
    const endpointRes = result2.perType.find((p) => p.entityType === 'endpoint')!;
    expect(endpointRes.published).toBe(1);
    expect(endpointRes.skippedNoChange).toBe(0);
    expect(publisher.calls.length).toBe(firstCallCount + 1);
  });

  it('error isolation : stub échoue sur 1 entité, le scan continue', async () => {
    const { scheduler, publisher, endpointStreaming } = makeScheduler(db);
    const now = 1_000_000;
    const u1 = '1'.repeat(64);
    const u2 = '2'.repeat(64);
    seedSafeEndpoint(endpointStreaming, u1, now);
    seedSafeEndpoint(endpointStreaming, u2, now);

    // Arme l'échec pour le prochain appel publish seulement.
    publisher.nextShouldFail = true;

    const result = await scheduler.runScan(now);
    const endpointRes = result.perType.find((p) => p.entityType === 'endpoint')!;

    expect(endpointRes.scanned).toBe(2);
    expect(endpointRes.errors).toBe(1);
    expect(endpointRes.published).toBe(1);
    expect(publisher.calls).toHaveLength(2); // les deux tentatives ont eu lieu
  });

  it('RISKY verdict sur une entité avec beaucoup d\'échecs passe aussi par shouldRepublish', async () => {
    const { scheduler, publisher, endpointStreaming, publishedEvents } = makeScheduler(db);
    const urlHash = 'd'.repeat(64);
    const now = 1_000_000;
    seedRiskyEndpoint(endpointStreaming, urlHash, now);

    const result = await scheduler.runScan(now);
    const endpointRes = result.perType.find((p) => p.entityType === 'endpoint')!;
    expect(endpointRes.published).toBe(1);

    const cached = publishedEvents.getLastPublished('endpoint', urlHash);
    expect(cached!.verdict).toBe('RISKY');
  });

  it('scan nodes : même logique que endpoints, kind 30382', async () => {
    const { scheduler, publisher, nodeStreaming } = makeScheduler(db);
    const pubkey = '02' + 'f'.repeat(64);
    const now = 1_000_000;
    for (let i = 0; i < 30; i++) {
      nodeStreaming.ingest(pubkey, 'probe', { successDelta: 1, failureDelta: 0, nowSec: now });
    }
    for (let i = 0; i < 30; i++) {
      nodeStreaming.ingest(pubkey, 'report', { successDelta: 1, failureDelta: 0, nowSec: now });
    }

    const result = await scheduler.runScan(now);
    const nodeRes = result.perType.find((p) => p.entityType === 'node')!;
    expect(nodeRes.published).toBe(1);
    expect(publisher.calls[0].kind).toBe(30382);
    expect(publisher.calls[0].entityId).toBe(pubkey);
  });

  it('pas de flash sur first_publish — aucune transition antérieure', async () => {
    const { scheduler, publisher, endpointStreaming } = makeScheduler(db);
    const urlHash = 'e'.repeat(64);
    const now = 1_000_000;
    seedSafeEndpoint(endpointStreaming, urlHash, now);

    const result = await scheduler.runScan(now);
    const endpointRes = result.perType.find((p) => p.entityType === 'endpoint')!;
    expect(endpointRes.published).toBe(1);
    expect(endpointRes.flashesPublished).toBe(0);
    expect(publisher.flashCalls).toHaveLength(0);
  });

  it('flash émis sur transition SAFE → RISKY', async () => {
    const { scheduler, publisher, endpointStreaming } = makeScheduler(db);
    const urlHash = 'f'.repeat(64);
    const now = 1_000_000;
    seedSafeEndpoint(endpointStreaming, urlHash, now);
    await scheduler.runScan(now);
    expect(publisher.flashCalls).toHaveLength(0);

    // Bascule RISKY via injection de failures en masse.
    const later = now + 3600;
    for (let i = 0; i < 80; i++) {
      endpointStreaming.ingest(urlHash, 'probe', { successDelta: 0, failureDelta: 1, nowSec: later });
    }

    const result = await scheduler.runScan(later);
    const endpointRes = result.perType.find((p) => p.entityType === 'endpoint')!;
    expect(endpointRes.published).toBe(1);
    expect(endpointRes.flashesPublished).toBe(1);
    expect(publisher.flashCalls).toHaveLength(1);
    expect(publisher.flashCalls[0].fromVerdict).toBe('SAFE');
    expect(publisher.flashCalls[0].toVerdict).toBe('RISKY');
    expect(publisher.flashCalls[0].entityType).toBe('endpoint');
    expect(publisher.flashCalls[0].entityId).toBe(urlHash);
  });

  it('flash failure : le scheduler comptabilise flashErrors, endorsement reste OK', async () => {
    const { scheduler, publisher, endpointStreaming } = makeScheduler(db);
    const urlHash = 'a'.repeat(64);
    const now = 1_000_000;
    seedSafeEndpoint(endpointStreaming, urlHash, now);
    await scheduler.runScan(now);

    const later = now + 3600;
    for (let i = 0; i < 80; i++) {
      endpointStreaming.ingest(urlHash, 'probe', { successDelta: 0, failureDelta: 1, nowSec: later });
    }
    publisher.nextFlashShouldFail = true;

    const result = await scheduler.runScan(later);
    const endpointRes = result.perType.find((p) => p.entityType === 'endpoint')!;
    expect(endpointRes.published).toBe(1); // endorsement OK
    expect(endpointRes.flashesPublished).toBe(0);
    expect(endpointRes.flashErrors).toBe(1);
  });

  it('isVerdictTransition : first publish, same verdict, INSUFFICIENT → pas un flash', () => {
    expect(isVerdictTransition(null, 'SAFE')).toBe(false);
    expect(isVerdictTransition('SAFE', 'SAFE')).toBe(false);
    expect(isVerdictTransition('INSUFFICIENT', 'SAFE')).toBe(false);
    expect(isVerdictTransition('SAFE', 'INSUFFICIENT')).toBe(false);
    expect(isVerdictTransition('SAFE', 'RISKY')).toBe(true);
    expect(isVerdictTransition('RISKY', 'SAFE')).toBe(true);
    expect(isVerdictTransition('SAFE', 'UNKNOWN')).toBe(true);
    expect(isVerdictTransition('UNKNOWN', 'RISKY')).toBe(true);
  });

  it('fenêtre scanWindowSec filtre les entités anciennes', async () => {
    const { scheduler, endpointStreaming } = makeScheduler(db);
    const oldHash = 'a'.repeat(64);
    const newHash = 'b'.repeat(64);
    const old = 1_000_000;
    const now = old + 10_000; // +~2h45
    seedSafeEndpoint(endpointStreaming, oldHash, old);
    seedSafeEndpoint(endpointStreaming, newHash, now);

    const result = await scheduler.runScan(now, { scanWindowSec: 900 }); // 15 min
    const endpointRes = result.perType.find((p) => p.entityType === 'endpoint')!;
    expect(endpointRes.scanned).toBe(1); // seulement newHash
  });
});
