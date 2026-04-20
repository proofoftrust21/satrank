// Phase 8 — C8 : tests du service NIP-09 deletion.
// Vérifie :
//   - flag OFF → skipped_disabled, cache intact
//   - entité inconnue → skipped_unknown
//   - publish OK → cache row purgée, statut 'published'
//   - publish sans ack → 'publish_failed', cache gardée (pour retry)
//   - exception publisher → 'publish_failed'
//   - template kind 5 avec e-tag et k-tag corrects
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import { NostrPublishedEventsRepository } from '../repositories/nostrPublishedEventsRepository';
import {
  NostrDeletionService,
  buildDeletionRequest,
  KIND_DELETION_REQUEST,
} from '../nostr/nostrDeletionService';
import type { NostrMultiKindPublisher, PublishResult } from '../nostr/nostrMultiKindPublisher';

class StubPublisher {
  calls: Array<{ template: { kind: number; tags: string[][]; content: string } }> = [];
  nextShouldFail = false;
  nextShouldThrow = false;
  private counter = 0;

  async publishTemplate(template: { kind: number; tags: string[][]; content: string; created_at: number }): Promise<PublishResult> {
    this.calls.push({ template });
    if (this.nextShouldThrow) throw new Error('simulated publish failure');
    this.counter++;
    const eventId = this.counter.toString(16).padStart(64, '0');
    return {
      eventId,
      kind: template.kind,
      publishedAt: template.created_at,
      acks: this.nextShouldFail
        ? [{ relay: 'wss://stub', result: 'error', error: 'no ack' }]
        : [{ relay: 'wss://stub', result: 'success' }],
      anySuccess: !this.nextShouldFail,
    };
  }
}

function seedCacheRow(repo: NostrPublishedEventsRepository): void {
  repo.recordPublished({
    entityType: 'endpoint',
    entityId: 'urlhash-aaa',
    eventId: 'e'.repeat(64),
    eventKind: 30383,
    publishedAt: 1_000_000,
    payloadHash: 'h'.repeat(64),
    verdict: 'SAFE',
    advisoryLevel: 'green',
    pSuccess: 0.9,
    nObsEffective: 50,
  });
}

describe('buildDeletionRequest', () => {
  it('produit un kind 5 avec e-tag et k-tag', () => {
    const template = buildDeletionRequest('abc123', 30383, 1700000000, 'test reason');
    expect(template.kind).toBe(KIND_DELETION_REQUEST);
    expect(template.kind).toBe(5);
    expect(template.created_at).toBe(1700000000);
    expect(template.content).toBe('test reason');
    expect(template.tags).toContainEqual(['e', 'abc123']);
    expect(template.tags).toContainEqual(['k', '30383']);
  });

  it('content vide par défaut', () => {
    const template = buildDeletionRequest('abc', 30382, 1700000000);
    expect(template.content).toBe('');
  });
});

describe('NostrDeletionService', () => {
  let db: Database.Database;
  let repo: NostrPublishedEventsRepository;
  let publisher: StubPublisher;
  let service: NostrDeletionService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    repo = new NostrPublishedEventsRepository(db);
    publisher = new StubPublisher();
  });

  afterEach(() => db.close());

  it('flag OFF → skipped_disabled, cache intact', async () => {
    service = new NostrDeletionService(publisher as unknown as NostrMultiKindPublisher, repo, false);
    seedCacheRow(repo);

    const result = await service.requestDeletion('endpoint', 'urlhash-aaa', 1700000000);
    expect(result.status).toBe('skipped_disabled');
    expect(result.deletionEventId).toBeNull();
    expect(publisher.calls).toHaveLength(0);
    expect(repo.getLastPublished('endpoint', 'urlhash-aaa')).not.toBeNull();
  });

  it('entité inconnue → skipped_unknown, pas d\'appel publisher', async () => {
    service = new NostrDeletionService(publisher as unknown as NostrMultiKindPublisher, repo, true);

    const result = await service.requestDeletion('endpoint', 'urlhash-unknown', 1700000000);
    expect(result.status).toBe('skipped_unknown');
    expect(publisher.calls).toHaveLength(0);
  });

  it('publish OK → cache purgée + statut published', async () => {
    service = new NostrDeletionService(publisher as unknown as NostrMultiKindPublisher, repo, true);
    seedCacheRow(repo);

    const result = await service.requestDeletion('endpoint', 'urlhash-aaa', 1700000000, { reason: 'compromised key' });

    expect(result.status).toBe('published');
    expect(result.deletionEventId).not.toBeNull();
    expect(result.targetEventId).toBe('e'.repeat(64));
    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0].template.kind).toBe(5);
    expect(publisher.calls[0].template.tags).toContainEqual(['e', 'e'.repeat(64)]);
    expect(publisher.calls[0].template.tags).toContainEqual(['k', '30383']);
    expect(publisher.calls[0].template.content).toBe('compromised key');
    expect(repo.getLastPublished('endpoint', 'urlhash-aaa')).toBeNull();
  });

  it('publish sans ack → publish_failed, cache conservée', async () => {
    service = new NostrDeletionService(publisher as unknown as NostrMultiKindPublisher, repo, true);
    seedCacheRow(repo);
    publisher.nextShouldFail = true;

    const result = await service.requestDeletion('endpoint', 'urlhash-aaa', 1700000000);

    expect(result.status).toBe('publish_failed');
    expect(repo.getLastPublished('endpoint', 'urlhash-aaa')).not.toBeNull();
  });

  it('exception publisher → publish_failed, pas de crash', async () => {
    service = new NostrDeletionService(publisher as unknown as NostrMultiKindPublisher, repo, true);
    seedCacheRow(repo);
    publisher.nextShouldThrow = true;

    const result = await service.requestDeletion('endpoint', 'urlhash-aaa', 1700000000);
    expect(result.status).toBe('publish_failed');
    expect(repo.getLastPublished('endpoint', 'urlhash-aaa')).not.toBeNull();
  });

  it('requestDeletionByEventId trouve via lookup event_id', async () => {
    service = new NostrDeletionService(publisher as unknown as NostrMultiKindPublisher, repo, true);
    seedCacheRow(repo);

    const result = await service.requestDeletionByEventId('e'.repeat(64), 1700000000);
    expect(result.status).toBe('published');
    expect(repo.findByEventId('e'.repeat(64))).toBeNull();
  });

  it('requestDeletionByEventId → skipped_unknown pour event inconnu', async () => {
    service = new NostrDeletionService(publisher as unknown as NostrMultiKindPublisher, repo, true);

    const result = await service.requestDeletionByEventId('z'.repeat(64), 1700000000);
    expect(result.status).toBe('skipped_unknown');
    expect(publisher.calls).toHaveLength(0);
  });

  it('préserve la symétrie : flag OFF peut devenir ON sans code change', async () => {
    service = new NostrDeletionService(publisher as unknown as NostrMultiKindPublisher, repo, false);
    seedCacheRow(repo);
    const r1 = await service.requestDeletion('endpoint', 'urlhash-aaa', 1700000000);
    expect(r1.status).toBe('skipped_disabled');

    service = new NostrDeletionService(publisher as unknown as NostrMultiKindPublisher, repo, true);
    const r2 = await service.requestDeletion('endpoint', 'urlhash-aaa', 1700000001);
    expect(r2.status).toBe('published');
  });
});
