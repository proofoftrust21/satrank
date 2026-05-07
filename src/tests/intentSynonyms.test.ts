// Sim 9 Fix 3 — category synonym fallback unit test.
import { describe, it, expect } from 'vitest';
import { expandCategory } from '../services/intentService';

describe('expandCategory (Sim 9 Fix 3)', () => {
  it('returns input first then synonyms (preserves canonical match priority)', () => {
    expect(expandCategory('finance')).toEqual(['finance', 'data/finance']);
    expect(expandCategory('crypto')).toEqual(['crypto', 'bitcoin']);
    expect(expandCategory('weather')).toEqual(['weather', 'data', 'energy/intelligence']);
  });

  it('case-insensitive lookup', () => {
    expect(expandCategory('FINANCE')).toEqual(['FINANCE', 'data/finance']);
    expect(expandCategory('Crypto')).toEqual(['Crypto', 'bitcoin']);
  });

  it('returns single-element list when input has no synonyms', () => {
    expect(expandCategory('data')).toEqual(['data']);
    expect(expandCategory('ai')).toEqual(['ai']);
    expect(expandCategory('totally-unknown-category')).toEqual(['totally-unknown-category']);
  });

  it('dedupes when input already matches a synonym', () => {
    // 'data' is already a synonym for 'weather'; no double-count.
    expect(expandCategory('data')).toEqual(['data']);
  });

  it('LLM/AI vocabulary maps to ai/text and ai cascade', () => {
    expect(expandCategory('llm')).toEqual(['llm', 'ai/text', 'ai']);
    expect(expandCategory('language')).toEqual(['language', 'ai/text', 'ai']);
    expect(expandCategory('image')).toEqual(['image', 'ai/image', 'ai']);
    expect(expandCategory('code')).toEqual(['code', 'ai/code', 'ai']);
  });

  it('finance vocabulary maps to data/finance', () => {
    expect(expandCategory('stocks')).toEqual(['stocks', 'data/finance']);
    expect(expandCategory('forex')).toEqual(['forex', 'data/finance']);
    expect(expandCategory('exchange')).toEqual(['exchange', 'data/finance']);
    expect(expandCategory('market')).toEqual(['market', 'data/finance', 'data']);
  });

  // Phase 12.7 (2026-05-06) — Sim 15 a3 HARMFUL : "energy/intelligence
  // returned zero candidates — synonym/canonical mapping is missing
  // for compound categories the hint sheet explicitly suggested".
  describe('Phase 12.7 — compound category fallback', () => {
    it('explicit synonym for energy/intelligence falls back to finance + data', () => {
      expect(expandCategory('energy/intelligence')).toEqual([
        'energy/intelligence',
        'data/finance',
        'data/government',
        'data',
      ]);
    });

    it('auto-fallback for unknown compound A/B tries data/B, data/A, B, A (no `data` catch-all post-Phase-12.13)', () => {
      // Compound not in the explicit synonyms map.
      // Phase 12.13 (Sim 20 follow-up) — removed the trailing `data`
      // catch-all to prevent silent mis-routing of off-taxonomy intents
      // (a03 energy/intelligence, a06 news classifier).
      expect(expandCategory('foo/bar')).toEqual([
        'foo/bar',
        'data/bar',
        'data/foo',
        'bar',
        'foo',
      ]);
    });

    it('explicit synonym wins over auto-fallback (no duplication)', () => {
      // 'data/news' has explicit synonym ['data'], so the auto-fallback
      // path is NOT triggered (CATEGORY_SYNONYMS hit takes precedence).
      expect(expandCategory('data/news')).toEqual(['data/news', 'data']);
    });

    it('non-compound input is unaffected by the auto-fallback', () => {
      expect(expandCategory('totally-unknown')).toEqual(['totally-unknown']);
    });

    it('case-insensitive on compound', () => {
      // Phase 12.13 — no trailing `data` catch-all.
      expect(expandCategory('Foo/Bar')).toEqual([
        'Foo/Bar',
        'data/bar',
        'data/foo',
        'bar',
        'foo',
      ]);
    });

    it('three-segment compound only auto-falls when 2-part (Phase 12.13: no `data` catch-all)', () => {
      // 'data/a/b' has 3 parts → auto-fallback skipped. Phase 12.13 also
      // removed the unconditional `data` push.
      expect(expandCategory('data/a/b')).toEqual(['data/a/b']);
    });
  });
});
