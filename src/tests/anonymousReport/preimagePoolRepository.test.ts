// Tests PreimagePoolRepository — insertIfAbsent idempotence, consumeAtomic
// one-shot, concurrent race. La sémantique atomique est la garantie clé
// qui empêche les double-reports.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../database/migrations';
import { PreimagePoolRepository, tierToReporterWeight } from '../../repositories/preimagePoolRepository';

const NOW = Math.floor(Date.now() / 1000);

describe('PreimagePoolRepository', () => {
  let db: Database.Database;
  let repo: PreimagePoolRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    repo = new PreimagePoolRepository(db);
  });

  afterEach(() => db.close());

  it('insertIfAbsent inserts a new entry and returns true', () => {
    const ok = repo.insertIfAbsent({
      paymentHash: 'ph1',
      bolt11Raw: 'lnbc100u1pxxxx',
      firstSeen: NOW,
      confidenceTier: 'medium',
      source: 'crawler',
    });
    expect(ok).toBe(true);

    const row = repo.findByPaymentHash('ph1');
    expect(row).not.toBeNull();
    expect(row?.confidence_tier).toBe('medium');
    expect(row?.source).toBe('crawler');
    expect(row?.consumed_at).toBeNull();
  });

  it('insertIfAbsent is idempotent — second call returns false, preserves original tier/source', () => {
    repo.insertIfAbsent({ paymentHash: 'ph1', bolt11Raw: null, firstSeen: NOW, confidenceTier: 'medium', source: 'crawler' });
    const second = repo.insertIfAbsent({ paymentHash: 'ph1', bolt11Raw: null, firstSeen: NOW + 10, confidenceTier: 'low', source: 'report' });
    expect(second).toBe(false);
    const row = repo.findByPaymentHash('ph1');
    expect(row?.confidence_tier).toBe('medium');
    expect(row?.source).toBe('crawler');
  });

  it('findByPaymentHash returns null for unknown hash', () => {
    expect(repo.findByPaymentHash('unknown')).toBeNull();
  });

  it('consumeAtomic succeeds once, returns false on second call (one-shot)', () => {
    repo.insertIfAbsent({ paymentHash: 'ph-once', bolt11Raw: null, firstSeen: NOW, confidenceTier: 'low', source: 'report' });
    const first = repo.consumeAtomic('ph-once', 'report-1', NOW + 5);
    expect(first).toBe(true);
    const second = repo.consumeAtomic('ph-once', 'report-2', NOW + 6);
    expect(second).toBe(false);

    const row = repo.findByPaymentHash('ph-once');
    expect(row?.consumed_at).toBe(NOW + 5);
    expect(row?.consumer_report_id).toBe('report-1');
  });

  it('consumeAtomic returns false on unknown payment_hash', () => {
    const ok = repo.consumeAtomic('never-inserted', 'report-x', NOW);
    expect(ok).toBe(false);
  });

  it('concurrent consume race — exactement 1 winner sur N tentatives sur la même preimage', () => {
    // better-sqlite3 est synchrone → on simule la race en séquentialisant
    // mais en utilisant la même transaction implicite. La sémantique UPDATE
    // ... WHERE consumed_at IS NULL reste l'invariant testé.
    repo.insertIfAbsent({ paymentHash: 'race-ph', bolt11Raw: null, firstSeen: NOW, confidenceTier: 'medium', source: 'crawler' });
    const attempts = Array.from({ length: 5 }, (_, i) => () => repo.consumeAtomic('race-ph', `report-${i}`, NOW + i));
    const results = attempts.map(fn => fn());
    const winners = results.filter(r => r === true);
    expect(winners.length).toBe(1);

    const row = repo.findByPaymentHash('race-ph');
    expect(row?.consumed_at).toBe(NOW); // premier appel gagne (i=0)
    expect(row?.consumer_report_id).toBe('report-0');
  });

  it('countByTier groups entries correctement', () => {
    repo.insertIfAbsent({ paymentHash: 'h1', bolt11Raw: null, firstSeen: NOW, confidenceTier: 'medium', source: 'crawler' });
    repo.insertIfAbsent({ paymentHash: 'h2', bolt11Raw: null, firstSeen: NOW, confidenceTier: 'medium', source: 'intent' });
    repo.insertIfAbsent({ paymentHash: 'h3', bolt11Raw: null, firstSeen: NOW, confidenceTier: 'low', source: 'report' });
    const counts = repo.countByTier();
    expect(counts).toEqual({ high: 0, medium: 2, low: 1 });
  });
});

describe('tierToReporterWeight', () => {
  it('maps high=0.7, medium=0.5, low=0.3', () => {
    expect(tierToReporterWeight('high')).toBe(0.7);
    expect(tierToReporterWeight('medium')).toBe(0.5);
    expect(tierToReporterWeight('low')).toBe(0.3);
  });
});
