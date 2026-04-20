// Phase 8 — migration v38.
//
// Garde-fou sur le cache des events Nostr publiés :
//   - Une table nostr_published_events (clé composée entity_type + entity_id)
//   - CHECK constraint entity_type ∈ {node, endpoint, service}
//   - 2 indexes : idx_nostr_published_updated (DESC), idx_nostr_published_kind
//   - Rollback réversible : down(v38) drop tout.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, rollbackTo, getAppliedVersions } from '../database/migrations';

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(name) as { found: number } | undefined;
  return !!row;
}

function indexExists(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='index' AND name=?").get(name) as { found: number } | undefined;
  return !!row;
}

describe('migration v38 — nostr_published_events (Phase 8)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => db.close());

  it('creates the nostr_published_events table and its indexes', () => {
    expect(tableExists(db, 'nostr_published_events')).toBe(true);
    expect(indexExists(db, 'idx_nostr_published_updated')).toBe(true);
    expect(indexExists(db, 'idx_nostr_published_kind')).toBe(true);
  });

  it('has the expected columns with the correct types', () => {
    const rows = db.prepare('PRAGMA table_info(nostr_published_events)').all() as {
      name: string; type: string; notnull: number; pk: number;
    }[];
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.entity_type).toEqual(expect.objectContaining({ type: 'TEXT', notnull: 1, pk: 1 }));
    expect(byName.entity_id).toEqual(expect.objectContaining({ type: 'TEXT', notnull: 1, pk: 2 }));
    expect(byName.event_id).toEqual(expect.objectContaining({ type: 'TEXT', notnull: 1 }));
    expect(byName.event_kind).toEqual(expect.objectContaining({ type: 'INTEGER', notnull: 1 }));
    expect(byName.published_at).toEqual(expect.objectContaining({ type: 'INTEGER', notnull: 1 }));
    expect(byName.payload_hash).toEqual(expect.objectContaining({ type: 'TEXT', notnull: 1 }));
    expect(byName.verdict).toEqual(expect.objectContaining({ type: 'TEXT', notnull: 0 }));
    expect(byName.advisory_level).toEqual(expect.objectContaining({ type: 'TEXT', notnull: 0 }));
    expect(byName.p_success).toEqual(expect.objectContaining({ type: 'REAL', notnull: 0 }));
    expect(byName.n_obs_effective).toEqual(expect.objectContaining({ type: 'REAL', notnull: 0 }));
  });

  it('enforces the entity_type CHECK constraint', () => {
    const insert = db.prepare(`
      INSERT INTO nostr_published_events
        (entity_type, entity_id, event_id, event_kind, published_at, payload_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    // Légal
    expect(() => insert.run('node', 'abc', 'evt1', 30382, 1776000000, 'h1')).not.toThrow();
    expect(() => insert.run('endpoint', 'def', 'evt2', 30383, 1776000000, 'h2')).not.toThrow();
    expect(() => insert.run('service', 'ghi', 'evt3', 30384, 1776000000, 'h3')).not.toThrow();
    // Illégal
    expect(() => insert.run('operator', 'zzz', 'evt4', 30385, 1776000000, 'h4')).toThrow(/CHECK constraint/);
  });

  it('upserts on the composite primary key (entity_type, entity_id)', () => {
    const insert = db.prepare(`
      INSERT INTO nostr_published_events
        (entity_type, entity_id, event_id, event_kind, published_at, payload_hash, verdict, p_success)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET
        event_id = excluded.event_id,
        published_at = excluded.published_at,
        payload_hash = excluded.payload_hash,
        verdict = excluded.verdict,
        p_success = excluded.p_success
    `);
    insert.run('node', 'pk1', 'evt-v1', 30382, 1776000000, 'hash-v1', 'SAFE', 0.85);
    insert.run('node', 'pk1', 'evt-v2', 30382, 1776000100, 'hash-v2', 'RISKY', 0.30);

    const row = db.prepare('SELECT * FROM nostr_published_events WHERE entity_id = ?').get('pk1') as {
      event_id: string; verdict: string; p_success: number;
    };
    expect(row.event_id).toBe('evt-v2');
    expect(row.verdict).toBe('RISKY');
    expect(row.p_success).toBeCloseTo(0.30, 5);
  });

  it('rollback to v37 drops the table and its indexes', () => {
    rollbackTo(db, 37);
    expect(tableExists(db, 'nostr_published_events')).toBe(false);
    expect(indexExists(db, 'idx_nostr_published_updated')).toBe(false);
    expect(indexExists(db, 'idx_nostr_published_kind')).toBe(false);
    // v37 tables still present
    expect(tableExists(db, 'operators')).toBe(true);
    // applied_versions no longer contains 38
    const versions = getAppliedVersions(db);
    expect(versions.map((v) => v.version)).not.toContain(38);
    expect(versions.map((v) => v.version)).toContain(37);
  });

  it('re-running migrations is idempotent (no duplicate error)', () => {
    expect(() => runMigrations(db)).not.toThrow();
    const count = db.prepare('SELECT COUNT(*) AS c FROM schema_version WHERE version = 38').get() as { c: number };
    expect(count.c).toBe(1);
  });
});
