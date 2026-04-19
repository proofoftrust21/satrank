// parseIntent() unit coverage — EN only (SDK 1.0).
import { describe, it, expect } from 'vitest';
import { parseIntent } from '../src/nlp/parseIntent';

const CATS = [
  'data',
  'data/finance',
  'data/health',
  'data/weather',
  'ai',
  'ai/text',
  'ai/code',
  'tools',
  'tools/search',
  'bitcoin',
  'media',
];

describe('parseIntent — category resolution', () => {
  it('matches the literal category string verbatim (confidence=1)', () => {
    const r = parseIntent('I need data/finance numbers', { categories: CATS });
    expect(r.intent.category).toBe('data/finance');
    expect(r.category_confidence).toBe(1);
  });

  it('matches single-token categories via token membership', () => {
    const r = parseIntent('Give me bitcoin price info', { categories: CATS });
    expect(r.intent.category).toBe('bitcoin');
    expect(r.category_confidence).toBe(1);
  });

  it('flags ambiguity when scores tie (close top-2)', () => {
    // "data" alone — matches both "data" (1.0) and sub-cats partially.
    const r = parseIntent('latest data please', { categories: CATS });
    expect(r.intent.category).toBe('data');
    // No ambiguous — top is literal, subs are partial ≤ 0.5
    expect(r.ambiguous_categories).toBeUndefined();
  });

  it('returns empty category + confidence 0 when nothing matches', () => {
    const r = parseIntent('cook me a pizza', { categories: CATS });
    expect(r.intent.category).toBe('');
    expect(r.category_confidence).toBe(0);
  });

  it('honors synonyms as highest-priority override', () => {
    const r = parseIntent('give me a weather forecast', {
      categories: CATS,
      synonyms: { 'weather forecast': 'data/weather' },
    });
    expect(r.intent.category).toBe('data/weather');
    expect(r.category_confidence).toBe(1);
  });

  it('partial hits on compound categories produce fractional confidence', () => {
    const r = parseIntent('get me some health info', { categories: CATS });
    // "health" hits the /health half of "data/health"; parts = [data, health]
    // → 1/2 = 0.5
    expect(r.intent.category).toBe('data/health');
    expect(r.category_confidence).toBeCloseTo(0.5, 2);
  });
});

describe('parseIntent — budget extraction', () => {
  it('parses "under N sats"', () => {
    const r = parseIntent('bitcoin tools under 50 sats', { categories: CATS });
    expect(r.intent.budget_sats).toBe(50);
  });

  it('parses "max N sats"', () => {
    const r = parseIntent('data max 200 sats', { categories: CATS });
    expect(r.intent.budget_sats).toBe(200);
  });

  it('parses "for N sats"', () => {
    const r = parseIntent('ai for 100 sats', { categories: CATS });
    expect(r.intent.budget_sats).toBe(100);
  });

  it('parses bare "N sats"', () => {
    const r = parseIntent('tools 25 sats', { categories: CATS });
    expect(r.intent.budget_sats).toBe(25);
  });

  it('tolerates thousands separator "1,000 sats"', () => {
    const r = parseIntent('ai 1,000 sats', { categories: CATS });
    expect(r.intent.budget_sats).toBe(1000);
  });

  it('ignores "sats" appearing without a number', () => {
    const r = parseIntent('paying in sats for data', { categories: CATS });
    expect(r.intent.budget_sats).toBeUndefined();
  });
});

describe('parseIntent — latency extraction', () => {
  it('parses "within 3 seconds"', () => {
    const r = parseIntent('ai/text within 3 seconds', { categories: CATS });
    expect(r.intent.max_latency_ms).toBe(3000);
  });

  it('parses "under 500ms"', () => {
    const r = parseIntent('tools under 500ms', { categories: CATS });
    expect(r.intent.max_latency_ms).toBe(500);
  });

  it('expands "urgent" to 1000ms', () => {
    const r = parseIntent('urgent bitcoin price', { categories: CATS });
    expect(r.intent.max_latency_ms).toBe(1000);
  });

  it('expands "fast" to 2000ms', () => {
    const r = parseIntent('fast data', { categories: CATS });
    expect(r.intent.max_latency_ms).toBe(2000);
  });

  it('prefers explicit numeric over keyword', () => {
    const r = parseIntent('fast tools under 250ms', { categories: CATS });
    expect(r.intent.max_latency_ms).toBe(250);
  });

  it('leaves max_latency_ms undefined when no signal', () => {
    const r = parseIntent('give me bitcoin data', { categories: CATS });
    expect(r.intent.max_latency_ms).toBeUndefined();
  });
});

describe('parseIntent — keyword extraction', () => {
  it('drops stopwords and category tokens', () => {
    const r = parseIntent('I need the latest bitcoin price quickly', {
      categories: CATS,
    });
    // "I", "need", "the" → stopwords; "bitcoin" → category token; "quickly" → latency keyword
    // Remaining: "latest", "price" (and "price" also stopworded — check).
    expect(r.intent.keywords).toBeDefined();
    expect(r.intent.keywords).toContain('latest');
    expect(r.intent.keywords).not.toContain('bitcoin');
    expect(r.intent.keywords).not.toContain('the');
    expect(r.intent.keywords).not.toContain('i');
  });

  it('caps keywords at 5 items', () => {
    const r = parseIntent(
      'weather storm radar precipitation humidity pressure wind chill',
      { categories: CATS },
    );
    expect((r.intent.keywords ?? []).length).toBeLessThanOrEqual(5);
  });

  it('deduplicates repeated tokens', () => {
    const r = parseIntent('weather storm storm storm', { categories: CATS });
    const storms = (r.intent.keywords ?? []).filter((k) => k === 'storm');
    expect(storms.length).toBe(1);
  });

  it('returns no keywords when input is only stopwords', () => {
    const r = parseIntent('please tell me about it', { categories: CATS });
    expect(r.intent.keywords).toBeUndefined();
  });
});

describe('parseIntent — full-sentence fixtures', () => {
  it('"I need weather data fast under 50 sats"', () => {
    const r = parseIntent('I need weather data fast under 50 sats', {
      categories: CATS,
    });
    expect(r.intent.category).toBe('data/weather');
    expect(r.intent.budget_sats).toBe(50);
    expect(r.intent.max_latency_ms).toBe(2000);
  });

  it('"give me the bitcoin price within 3 seconds for 10 sats"', () => {
    const r = parseIntent(
      'give me the bitcoin price within 3 seconds for 10 sats',
      { categories: CATS },
    );
    expect(r.intent.category).toBe('bitcoin');
    expect(r.intent.budget_sats).toBe(10);
    expect(r.intent.max_latency_ms).toBe(3000);
  });

  it('"ai/code helper under 200 sats"', () => {
    const r = parseIntent('ai/code helper under 200 sats', { categories: CATS });
    expect(r.intent.category).toBe('ai/code');
    expect(r.intent.budget_sats).toBe(200);
    expect(r.intent.keywords).toContain('helper');
  });

  it('preserves extra keywords when categories are matched', () => {
    const r = parseIntent('search engine for typescript libraries', {
      categories: CATS,
    });
    expect(r.intent.category).toBe('tools/search');
    expect(r.intent.keywords).toEqual(
      expect.arrayContaining(['engine', 'typescript', 'libraries']),
    );
  });
});

describe('parseIntent — input guards', () => {
  it('throws on empty string', () => {
    expect(() => parseIntent('', { categories: CATS })).toThrow(/non-empty/);
    expect(() => parseIntent('   ', { categories: CATS })).toThrow(/non-empty/);
  });

  it('throws when categories is not an array', () => {
    expect(() =>
      parseIntent('anything', {
        categories: 'data' as unknown as string[],
      }),
    ).toThrow(/array/);
  });

  it('tolerates an empty categories list (confidence=0)', () => {
    const r = parseIntent('I want bitcoin', { categories: [] });
    expect(r.category_confidence).toBe(0);
  });
});
