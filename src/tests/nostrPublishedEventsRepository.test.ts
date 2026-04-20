// Phase 8 — C5/C7 : tests du cache nostr_published_events.
// Vérifie :
//   - getLastPublished null sur entité inconnue
//   - recordPublished crée la row, replay met à jour in-place
//   - delete retourne true/false et vire la row
//   - listByType filtre + order DESC par published_at + limit
//   - countByKind agrège bien par event_kind
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import {
  NostrPublishedEventsRepository,
  type RecordPublishedInput,
} from '../repositories/nostrPublishedEventsRepository';

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

describe('NostrPublishedEventsRepository', () => {
  let db: Database.Database;
  let repo: NostrPublishedEventsRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    repo = new NostrPublishedEventsRepository(db);
  });

  afterEach(() => db.close());

  it('getLastPublished retourne null sur entité inconnue', () => {
    expect(repo.getLastPublished('endpoint', 'nope')).toBeNull();
  });

  it('recordPublished insère puis getLastPublished retourne le snapshot', () => {
    const input = baseInput();
    repo.recordPublished(input);
    const row = repo.getLastPublished('endpoint', 'urlhash-aaa');
    expect(row).not.toBeNull();
    expect(row!.event_id).toBe(input.eventId);
    expect(row!.event_kind).toBe(30383);
    expect(row!.verdict).toBe('SAFE');
    expect(row!.advisory_level).toBe('green');
    expect(row!.p_success).toBe(0.8);
    expect(row!.n_obs_effective).toBe(42);
  });

  it('recordPublished est un upsert sur (entity_type, entity_id)', () => {
    repo.recordPublished(baseInput({ eventId: 'a'.repeat(64), publishedAt: 1000, pSuccess: 0.5 }));
    repo.recordPublished(baseInput({ eventId: 'b'.repeat(64), publishedAt: 2000, pSuccess: 0.9, verdict: 'RISKY', advisoryLevel: 'orange' }));
    const row = repo.getLastPublished('endpoint', 'urlhash-aaa');
    expect(row!.event_id).toBe('b'.repeat(64));
    expect(row!.published_at).toBe(2000);
    expect(row!.p_success).toBe(0.9);
    expect(row!.verdict).toBe('RISKY');
    expect(row!.advisory_level).toBe('orange');
  });

  it('isole les entity_type : même entity_id mais type différent = rows différentes', () => {
    repo.recordPublished(baseInput({ entityType: 'endpoint', entityId: 'shared-id', eventKind: 30383 }));
    repo.recordPublished(baseInput({ entityType: 'node', entityId: 'shared-id', eventKind: 30382 }));
    const endpoint = repo.getLastPublished('endpoint', 'shared-id');
    const node = repo.getLastPublished('node', 'shared-id');
    expect(endpoint!.event_kind).toBe(30383);
    expect(node!.event_kind).toBe(30382);
  });

  it('delete vire la row et retourne true/false selon existence', () => {
    repo.recordPublished(baseInput());
    expect(repo.delete('endpoint', 'urlhash-aaa')).toBe(true);
    expect(repo.getLastPublished('endpoint', 'urlhash-aaa')).toBeNull();
    expect(repo.delete('endpoint', 'urlhash-aaa')).toBe(false);
  });

  it('listByType filtre par type, ordonne published_at DESC, respecte limit', () => {
    repo.recordPublished(baseInput({ entityId: 'a', publishedAt: 1000 }));
    repo.recordPublished(baseInput({ entityId: 'b', publishedAt: 3000 }));
    repo.recordPublished(baseInput({ entityId: 'c', publishedAt: 2000 }));
    repo.recordPublished(baseInput({ entityType: 'node', entityId: 'node-x', publishedAt: 4000, eventKind: 30382 }));

    const endpoints = repo.listByType('endpoint');
    expect(endpoints.map((r) => r.entity_id)).toEqual(['b', 'c', 'a']);

    const limited = repo.listByType('endpoint', 2);
    expect(limited).toHaveLength(2);
    expect(limited[0].entity_id).toBe('b');
  });

  it('countByKind aggregates par event_kind', () => {
    repo.recordPublished(baseInput({ entityId: 'a', eventKind: 30383 }));
    repo.recordPublished(baseInput({ entityId: 'b', eventKind: 30383 }));
    repo.recordPublished(baseInput({ entityType: 'node', entityId: 'n1', eventKind: 30382 }));
    const counts = repo.countByKind();
    expect(counts[30383]).toBe(2);
    expect(counts[30382]).toBe(1);
  });
});
