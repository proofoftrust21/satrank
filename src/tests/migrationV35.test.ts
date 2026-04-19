// Phase 3 refactor — migration v35.
//
// Garde-fou sur le schema du nouveau modèle streaming :
//   - 5 tables *_streaming_posteriors (endpoint/node/service/operator/route)
//     avec CHECK source IN ('probe','report','paid') — observer exclu
//   - 5 tables *_daily_buckets avec CHECK source IN ('probe','report','paid','observer')
//
// v35 est purement additive : les cinq *_aggregates restent en place pour
// que les callers qui les lisent continuent de fonctionner pendant la chaîne
// de refactor. Le DROP final sera fait en fin de chaîne (v36).
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

describe('migration v35 — streaming posteriors + daily buckets (additive)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => db.close());

  it('creates the five streaming_posteriors tables', () => {
    for (const t of [
      'endpoint_streaming_posteriors',
      'node_streaming_posteriors',
      'service_streaming_posteriors',
      'operator_streaming_posteriors',
      'route_streaming_posteriors',
    ]) {
      expect(tableExists(db, t)).toBe(true);
    }
  });

  it('creates the five daily_buckets tables', () => {
    for (const t of [
      'endpoint_daily_buckets',
      'node_daily_buckets',
      'service_daily_buckets',
      'operator_daily_buckets',
      'route_daily_buckets',
    ]) {
      expect(tableExists(db, t)).toBe(true);
    }
  });

  it('drops the five *_aggregates tables (v36 final sweep)', () => {
    // v36 DROP aggregates — "no cohabitation" : le scoring est 100% streaming,
    // les aggregates n'ont plus aucun caller.
    for (const t of [
      'endpoint_aggregates',
      'node_aggregates',
      'service_aggregates',
      'operator_aggregates',
      'route_aggregates',
    ]) {
      expect(tableExists(db, t)).toBe(false);
    }
  });

  it('streaming_posteriors CHECK rejects observer source', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO endpoint_streaming_posteriors
        (url_hash, source, posterior_alpha, posterior_beta, last_update_ts)
        VALUES ('a', 'observer', 1.5, 1.5, 0)
      `).run();
    }).toThrow(/CHECK constraint/);
  });

  it('streaming_posteriors CHECK accepts probe / report / paid', () => {
    for (const src of ['probe', 'report', 'paid']) {
      db.prepare(`
        INSERT INTO endpoint_streaming_posteriors
        (url_hash, source, posterior_alpha, posterior_beta, last_update_ts)
        VALUES (?, ?, 1.5, 1.5, 0)
      `).run(`h-${src}`, src);
    }
    const rows = db.prepare('SELECT source FROM endpoint_streaming_posteriors').all() as { source: string }[];
    expect(rows).toHaveLength(3);
  });

  it('daily_buckets CHECK accepts observer source', () => {
    db.prepare(`
      INSERT INTO endpoint_daily_buckets
      (url_hash, source, day, n_obs, n_success, n_failure)
      VALUES ('a', 'observer', '2026-04-18', 1, 1, 0)
    `).run();
    const row = db.prepare("SELECT * FROM endpoint_daily_buckets WHERE source = 'observer'").get() as { n_obs: number };
    expect(row.n_obs).toBe(1);
  });

  it('schema_version has v35 recorded', () => {
    const versions = getAppliedVersions(db).map((v) => v.version);
    expect(versions).toContain(35);
  });

  it('has the streaming_ts indexes on all 5 streaming tables', () => {
    for (const idx of [
      'idx_endpoint_streaming_ts',
      'idx_node_streaming_ts',
      'idx_service_streaming_ts',
      'idx_operator_streaming_ts',
      'idx_route_streaming_ts',
    ]) {
      expect(indexExists(db, idx)).toBe(true);
    }
  });

  it('has the buckets_day indexes on all 5 bucket tables', () => {
    for (const idx of [
      'idx_endpoint_buckets_day',
      'idx_node_buckets_day',
      'idx_service_buckets_day',
      'idx_operator_buckets_day',
      'idx_route_buckets_day',
    ]) {
      expect(indexExists(db, idx)).toBe(true);
    }
  });

  it('rollback to v34 drops streaming + buckets but keeps aggregates', () => {
    rollbackTo(db, 34);
    for (const t of [
      'endpoint_streaming_posteriors',
      'endpoint_daily_buckets',
      'node_streaming_posteriors',
      'node_daily_buckets',
      'route_streaming_posteriors',
      'route_daily_buckets',
    ]) {
      expect(tableExists(db, t)).toBe(false);
    }
    // Aggregates sont intouchées par v35/down — elles doivent rester.
    for (const t of [
      'endpoint_aggregates',
      'node_aggregates',
      'service_aggregates',
      'operator_aggregates',
      'route_aggregates',
    ]) {
      expect(tableExists(db, t)).toBe(true);
    }
  });
});
