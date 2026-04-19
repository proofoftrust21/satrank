// Phase 7 — migration v37.
//
// Garde-fou sur le schema "operators" :
//   - 5 nouvelles tables : operators, operator_identities, operator_owns_node,
//     operator_owns_endpoint, operator_owns_service
//   - 2 colonnes additives : agents.operator_id, service_endpoints.operator_id
//   - CHECK constraints : verification_score ∈ [0..3], status ∈ {verified,pending,rejected},
//     identity_type ∈ {ln_pubkey, nip05, dns}
//   - FK ON DELETE CASCADE pour les 4 tables filles
//   - Rollback réversible : down(v37) doit tout nettoyer.
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

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

describe('migration v37 — operators abstraction (Phase 7)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => db.close());

  it('creates the five operator tables', () => {
    for (const t of [
      'operators',
      'operator_identities',
      'operator_owns_node',
      'operator_owns_endpoint',
      'operator_owns_service',
    ]) {
      expect(tableExists(db, t)).toBe(true);
    }
  });

  it('creates all required indexes', () => {
    for (const idx of [
      'idx_operators_status',
      'idx_operators_last_activity',
      'idx_operator_identities_verified_at',
      'idx_operator_identities_value',
      'idx_operator_owns_node_pubkey',
      'idx_operator_owns_endpoint_url_hash',
      'idx_operator_owns_service_hash',
      'idx_agents_operator_id',
      'idx_service_endpoints_operator_id',
    ]) {
      expect(indexExists(db, idx)).toBe(true);
    }
  });

  it('adds operator_id column to agents and service_endpoints (nullable)', () => {
    expect(columnExists(db, 'agents', 'operator_id')).toBe(true);
    expect(columnExists(db, 'service_endpoints', 'operator_id')).toBe(true);
  });

  it('operators.verification_score accepts 0..3 and rejects out-of-range', () => {
    const now = Date.now();
    for (const score of [0, 1, 2, 3]) {
      db.prepare(`INSERT INTO operators (operator_id, first_seen, last_activity, verification_score, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`)
        .run(`op-${score}`, now, now, score, now);
    }
    expect(() => {
      db.prepare(`INSERT INTO operators (operator_id, first_seen, last_activity, verification_score, status, created_at) VALUES ('op-4', ?, ?, 4, 'pending', ?)`).run(now, now, now);
    }).toThrow(/CHECK constraint/);
    expect(() => {
      db.prepare(`INSERT INTO operators (operator_id, first_seen, last_activity, verification_score, status, created_at) VALUES ('op-neg', ?, ?, -1, 'pending', ?)`).run(now, now, now);
    }).toThrow(/CHECK constraint/);
  });

  it('operators.status accepts verified/pending/rejected and rejects other', () => {
    const now = Date.now();
    for (const status of ['verified', 'pending', 'rejected']) {
      db.prepare(`INSERT INTO operators (operator_id, first_seen, last_activity, verification_score, status, created_at) VALUES (?, ?, ?, 0, ?, ?)`)
        .run(`op-${status}`, now, now, status, now);
    }
    expect(() => {
      db.prepare(`INSERT INTO operators (operator_id, first_seen, last_activity, verification_score, status, created_at) VALUES ('op-bad', ?, ?, 0, 'unknown', ?)`).run(now, now, now);
    }).toThrow(/CHECK constraint/);
  });

  it('operator_identities.identity_type accepts ln_pubkey/nip05/dns only', () => {
    const now = Date.now();
    db.prepare(`INSERT INTO operators (operator_id, first_seen, last_activity, verification_score, status, created_at) VALUES ('op1', ?, ?, 0, 'pending', ?)`).run(now, now, now);
    for (const type of ['ln_pubkey', 'nip05', 'dns']) {
      db.prepare(`INSERT INTO operator_identities (operator_id, identity_type, identity_value, verified_at, verification_proof) VALUES (?, ?, ?, NULL, NULL)`)
        .run('op1', type, `val-${type}`);
    }
    expect(() => {
      db.prepare(`INSERT INTO operator_identities (operator_id, identity_type, identity_value) VALUES ('op1', 'x509', 'cert')`).run();
    }).toThrow(/CHECK constraint/);
  });

  it('operator_identities cascades on DELETE operator', () => {
    const now = Date.now();
    db.prepare(`INSERT INTO operators (operator_id, first_seen, last_activity, verification_score, status, created_at) VALUES ('op1', ?, ?, 0, 'pending', ?)`).run(now, now, now);
    db.prepare(`INSERT INTO operator_identities (operator_id, identity_type, identity_value) VALUES ('op1', 'dns', 'example.com')`).run();
    db.prepare(`INSERT INTO operator_owns_node (operator_id, node_pubkey, claimed_at) VALUES ('op1', 'pk1', ?)`).run(now);
    db.prepare(`INSERT INTO operator_owns_endpoint (operator_id, url_hash, claimed_at) VALUES ('op1', 'h1', ?)`).run(now);
    db.prepare(`INSERT INTO operator_owns_service (operator_id, service_hash, claimed_at) VALUES ('op1', 's1', ?)`).run(now);

    db.prepare(`DELETE FROM operators WHERE operator_id = 'op1'`).run();

    const idCount = db.prepare(`SELECT COUNT(*) AS n FROM operator_identities WHERE operator_id = 'op1'`).get() as { n: number };
    const nodeCount = db.prepare(`SELECT COUNT(*) AS n FROM operator_owns_node WHERE operator_id = 'op1'`).get() as { n: number };
    const epCount = db.prepare(`SELECT COUNT(*) AS n FROM operator_owns_endpoint WHERE operator_id = 'op1'`).get() as { n: number };
    const svcCount = db.prepare(`SELECT COUNT(*) AS n FROM operator_owns_service WHERE operator_id = 'op1'`).get() as { n: number };
    expect(idCount.n).toBe(0);
    expect(nodeCount.n).toBe(0);
    expect(epCount.n).toBe(0);
    expect(svcCount.n).toBe(0);
  });

  it('defaults verification_score=0 and status=pending', () => {
    const now = Date.now();
    db.prepare(`INSERT INTO operators (operator_id, first_seen, last_activity, created_at) VALUES ('op-def', ?, ?, ?)`).run(now, now, now);
    const row = db.prepare(`SELECT verification_score, status FROM operators WHERE operator_id = 'op-def'`).get() as { verification_score: number; status: string };
    expect(row.verification_score).toBe(0);
    expect(row.status).toBe('pending');
  });

  it('operator_identities primary key is (operator_id, identity_type, identity_value)', () => {
    const now = Date.now();
    db.prepare(`INSERT INTO operators (operator_id, first_seen, last_activity, verification_score, status, created_at) VALUES ('op1', ?, ?, 0, 'pending', ?)`).run(now, now, now);
    db.prepare(`INSERT INTO operator_identities (operator_id, identity_type, identity_value) VALUES ('op1', 'dns', 'example.com')`).run();
    expect(() => {
      db.prepare(`INSERT INTO operator_identities (operator_id, identity_type, identity_value) VALUES ('op1', 'dns', 'example.com')`).run();
    }).toThrow(/UNIQUE constraint|PRIMARY KEY/i);
    // Same type, different value → OK (un operator peut revendiquer plusieurs domaines DNS)
    db.prepare(`INSERT INTO operator_identities (operator_id, identity_type, identity_value) VALUES ('op1', 'dns', 'other.com')`).run();
  });

  it('schema_version has v37 recorded', () => {
    const versions = getAppliedVersions(db).map((v) => v.version);
    expect(versions).toContain(37);
  });

  it('rollback to v36 drops all 5 operator tables + indexes', () => {
    rollbackTo(db, 36);
    for (const t of [
      'operators',
      'operator_identities',
      'operator_owns_node',
      'operator_owns_endpoint',
      'operator_owns_service',
    ]) {
      expect(tableExists(db, t)).toBe(false);
    }
    for (const idx of [
      'idx_operators_status',
      'idx_operators_last_activity',
      'idx_operator_identities_verified_at',
      'idx_operator_identities_value',
      'idx_operator_owns_node_pubkey',
      'idx_operator_owns_endpoint_url_hash',
      'idx_operator_owns_service_hash',
      'idx_agents_operator_id',
      'idx_service_endpoints_operator_id',
    ]) {
      expect(indexExists(db, idx)).toBe(false);
    }
  });

  it('rollback then re-runMigrations is idempotent (schema converges)', () => {
    rollbackTo(db, 36);
    expect(tableExists(db, 'operators')).toBe(false);
    runMigrations(db);
    expect(tableExists(db, 'operators')).toBe(true);
    expect(columnExists(db, 'agents', 'operator_id')).toBe(true);
    expect(columnExists(db, 'service_endpoints', 'operator_id')).toBe(true);
  });
});
