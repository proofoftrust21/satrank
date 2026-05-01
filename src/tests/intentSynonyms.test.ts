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
});
