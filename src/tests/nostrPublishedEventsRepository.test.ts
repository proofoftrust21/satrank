// Phase 8 — C5/C7 : tests du cache nostr_published_events.
// Vérifie :
//   - getLastPublished null sur entité inconnue
//   - recordPublished crée la row, replay met à jour in-place
//   - delete retourne true/false et vire la row
//   - listByType filtre + order DESC par published_at + limit
//   - countByKind agrège bien par event_kind
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import {
  NostrPublishedEventsRepository,
  type RecordPublishedInput,
} from '../repositories/nostrPublishedEventsRepository';
let testDb: TestDb;

function baseInput(overrides: Partial<RecordPublishedInput> = {}): RecordPublishedInput {
  return {
    entityType: 'endpoint',
    entityId: 'urlhash-aaa',
    eventId: 'e'.repeat(64),
    eventKind: 30383,
    publishedAt: 1_000_000,
    payloadHash: 'h'.repeat(64),
    verdict: 'SAFE',
    advisoryLevel: 'green',
    pSuccess: 0.8,
    nObsEffective: 42,
    ...overrides,
  };
}

describe('NostrPublishedEventsRepository', async () => {
  let db: Pool;
  let repo: NostrPublishedEventsRepository;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    repo = new NostrPublishedEventsRepository(db);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('getLastPublished retourne null sur entité inconnue', async () => {
    expect(await repo.getLastPublished('endpoint', 'nope')).toBeNull();
  });

  it('recordPublished insère puis getLastPublished retourne le snapshot', async () => {
    const input = baseInput();
    await repo.recordPublished(input);
    const row = await repo.getLastPublished('endpoint', 'urlhash-aaa');
    expect(row).not.toBeNull();
    expect(row!.event_id).toBe(input.eventId);
    expect(row!.event_kind).toBe(30383);
    expect(row!.verdict).toBe('SAFE');
    expect(row!.advisory_level).toBe('green');
    expect(row!.p_success).toBe(0.8);
    expect(row!.n_obs_effective).toBe(42);
  });

  it('recordPublished est un upsert sur (entity_type, entity_id)', async () => {
    await repo.recordPublished(baseInput({ eventId: 'a'.repeat(64), publishedAt: 1000, pSuccess: 0.5 }));
    await repo.recordPublished(baseInput({ eventId: 'b'.repeat(64), publishedAt: 2000, pSuccess: 0.9, verdict: 'RISKY', advisoryLevel: 'orange' }));
    const row = await repo.getLastPublished('endpoint', 'urlhash-aaa');
    expect(row!.event_id).toBe('b'.repeat(64));
    expect(row!.published_at).toBe(2000);
    expect(row!.p_success).toBe(0.9);
    expect(row!.verdict).toBe('RISKY');
    expect(row!.advisory_level).toBe('orange');
  });

  it('isole les entity_type : même entity_id mais type différent = rows différentes', async () => {
    await repo.recordPublished(baseInput({ entityType: 'endpoint', entityId: 'shared-id', eventKind: 30383 }));
    await repo.recordPublished(baseInput({ entityType: 'node', entityId: 'shared-id', eventKind: 30382 }));
    const endpoint = await repo.getLastPublished('endpoint', 'shared-id');
    const node = await repo.getLastPublished('node', 'shared-id');
    expect(endpoint!.event_kind).toBe(30383);
    expect(node!.event_kind).toBe(30382);
  });

  it('delete vire la row et retourne true/false selon existence', async () => {
    await repo.recordPublished(baseInput());
    expect(await repo.delete('endpoint', 'urlhash-aaa')).toBe(true);
    expect(await repo.getLastPublished('endpoint', 'urlhash-aaa')).toBeNull();
    expect(await repo.delete('endpoint', 'urlhash-aaa')).toBe(false);
  });

  it('listByType filtre par type, ordonne published_at DESC, respecte limit', async () => {
    await repo.recordPublished(baseInput({ entityId: 'a', publishedAt: 1000 }));
    await repo.recordPublished(baseInput({ entityId: 'b', publishedAt: 3000 }));
    await repo.recordPublished(baseInput({ entityId: 'c', publishedAt: 2000 }));
    await repo.recordPublished(baseInput({ entityType: 'node', entityId: 'node-x', publishedAt: 4000, eventKind: 30382 }));

    const endpoints = await repo.listByType('endpoint');
    expect(endpoints.map((r) => r.entity_id)).toEqual(['b', 'c', 'a']);

    const limited = await repo.listByType('endpoint', 2);
    expect(limited).toHaveLength(2);
    expect(limited[0].entity_id).toBe('b');
  });

  it('countByKind aggregates par event_kind', async () => {
    await repo.recordPublished(baseInput({ entityId: 'a', eventKind: 30383 }));
    await repo.recordPublished(baseInput({ entityId: 'b', eventKind: 30383 }));
    await repo.recordPublished(baseInput({ entityType: 'node', entityId: 'n1', eventKind: 30382 }));
    const counts = await repo.countByKind();
    expect(counts[30383]).toBe(2);
    expect(counts[30382]).toBe(1);
  });

  it('findByEventId retourne la row ou null', async () => {
    const eid = '7'.repeat(64);
    await repo.recordPublished(baseInput({ entityId: 'a', eventId: eid }));
    const row = await repo.findByEventId(eid);
    expect(row).not.toBeNull();
    expect(row!.entity_id).toBe('a');
    expect(await repo.findByEventId('z'.repeat(64))).toBeNull();
  });

  it('latestPublishedAtByType remonte le max(published_at) par type', async () => {
    await repo.recordPublished(baseInput({ entityId: 'e1', publishedAt: 500 }));
    await repo.recordPublished(baseInput({ entityId: 'e2', publishedAt: 1500 }));
    await repo.recordPublished(baseInput({ entityType: 'node', entityId: 'n1', publishedAt: 1000, eventKind: 30382 }));
    const latest = await repo.latestPublishedAtByType();
    expect(latest.endpoint).toBe(1500);
    expect(latest.node).toBe(1000);
    expect(latest.service).toBeNull();
  });
});
