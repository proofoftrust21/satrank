// Phase 12.2 (2026-05-05) — BM25 service tests.
import { describe, it, expect, beforeEach } from 'vitest';
import { Bm25Service, tokenize } from '../services/bm25Service';

describe('Phase 12.2 — tokenize', () => {
  it('lowercases and splits on non-alphanumeric', () => {
    expect(tokenize('FX trading API for BTC/USD')).toEqual(['fx', 'trading', 'api', 'btc', 'usd']);
  });

  it('drops English stopwords', () => {
    expect(tokenize('a list of the trading pairs')).toEqual(['list', 'trading', 'pairs']);
  });

  it('drops single-character tokens', () => {
    expect(tokenize('AI ML R Python')).toEqual(['ai', 'ml', 'python']);
  });

  it('handles empty / punctuation-only input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('!@#  ')).toEqual([]);
  });

  it('preserves digits inside words', () => {
    expect(tokenize('OHLC 1m candles')).toEqual(['ohlc', '1m', 'candles']);
  });
});

describe('Phase 12.2 — Bm25Service.buildIndex + topK', () => {
  let svc: Bm25Service;

  beforeEach(() => {
    svc = new Bm25Service();
  });

  it('zero docs → empty topK', () => {
    svc.buildIndex([]);
    expect(svc.topK('anything', 5)).toEqual([]);
    expect(svc.stats().docCount).toBe(0);
  });

  it('single doc, exact match scores > 0', () => {
    svc.buildIndex([{ id: 1, text: 'Bitcoin price API' }]);
    const top = svc.topK('Bitcoin price', 5);
    expect(top).toHaveLength(1);
    expect(top[0].id).toBe(1);
    expect(top[0].score).toBeGreaterThan(0);
  });

  it('ranks more relevant doc higher', () => {
    svc.buildIndex([
      { id: 1, text: 'Bitcoin price OHLC realtime API' },
      { id: 2, text: 'Weather forecast service' },
      { id: 3, text: 'Bitcoin news headlines' },
    ]);
    const top = svc.topK('bitcoin OHLC realtime', 3);
    expect(top[0].id).toBe(1); // contains all 3 query terms
    expect(top.map(t => t.id)).not.toContain(2); // weather doc has zero overlap
  });

  it('empty query returns empty topK', () => {
    svc.buildIndex([{ id: 1, text: 'something' }]);
    expect(svc.topK('', 3)).toEqual([]);
    expect(svc.topK('   !@#  ', 3)).toEqual([]);
  });

  it('honours the k limit', () => {
    const docs = [];
    for (let i = 0; i < 10; i += 1) docs.push({ id: i, text: 'finance trading api' });
    svc.buildIndex(docs);
    expect(svc.topK('finance', 3)).toHaveLength(3);
    expect(svc.topK('finance', 100)).toHaveLength(10);
  });

  it('shorter docs score higher for the same TF (length normalisation)', () => {
    svc.buildIndex([
      { id: 1, text: 'bitcoin' },
      { id: 2, text: 'bitcoin and many other things including weather and news and forex and trading and so on' },
    ]);
    const top = svc.topK('bitcoin', 2);
    expect(top[0].id).toBe(1);
    expect(top[0].score).toBeGreaterThan(top[1].score);
  });

  it('rare terms score higher than common terms (IDF working)', () => {
    const docs = [];
    // 9 docs containing "common" + 1 doc containing "rare"
    for (let i = 0; i < 9; i += 1) docs.push({ id: i, text: 'common term' });
    docs.push({ id: 99, text: 'rare unique' });
    svc.buildIndex(docs);
    const commonTop = svc.topK('common', 1);
    const rareTop = svc.topK('rare', 1);
    expect(rareTop[0].score).toBeGreaterThan(commonTop[0].score);
  });

  it('rebuild replaces index (no leakage from prior build)', () => {
    svc.buildIndex([{ id: 1, text: 'first' }]);
    svc.buildIndex([{ id: 2, text: 'second' }]);
    expect(svc.topK('first', 5)).toEqual([]);
    const top = svc.topK('second', 5);
    expect(top).toHaveLength(1);
    expect(top[0].id).toBe(2);
  });
});

describe('Phase 12.2 — Bm25Service.score (single-doc)', () => {
  let svc: Bm25Service;

  beforeEach(() => {
    svc = new Bm25Service();
    svc.buildIndex([
      { id: 1, text: 'Bitcoin Lightning payment API' },
      { id: 2, text: 'Forex market data realtime' },
    ]);
  });

  it('unknown doc → 0', () => {
    expect(svc.score(999, 'bitcoin')).toBe(0);
  });

  it('matching term → > 0', () => {
    expect(svc.score(1, 'bitcoin')).toBeGreaterThan(0);
  });

  it('non-matching query → 0', () => {
    expect(svc.score(1, 'forex')).toBe(0);
  });

  it('topK score for the doc equals score(doc, query)', () => {
    const top = svc.topK('bitcoin lightning', 5);
    expect(top.find(t => t.id === 1)?.score).toBeCloseTo(svc.score(1, 'bitcoin lightning'), 6);
  });
});

describe('Phase 12.2 — Bm25Service.explain', () => {
  let svc: Bm25Service;

  beforeEach(() => {
    svc = new Bm25Service();
    svc.buildIndex([
      { id: 1, text: 'Bitcoin Lightning OHLC realtime API' },
      { id: 2, text: 'Bitcoin news headlines' },
      { id: 3, text: 'Forex spot rates' },
    ]);
  });

  it('returns per-term contributions sorted desc', () => {
    const ex = svc.explain(1, 'bitcoin OHLC');
    expect(ex.length).toBeGreaterThan(0);
    expect(ex.map(e => e.term)).toContain('ohlc');
    expect(ex.map(e => e.term)).toContain('bitcoin');
    // sorted desc by contribution
    for (let i = 1; i < ex.length; i += 1) {
      expect(ex[i - 1].contribution).toBeGreaterThanOrEqual(ex[i].contribution);
    }
  });

  it('OHLC (rare) contributes more than bitcoin (common) on doc 1', () => {
    const ex = svc.explain(1, 'bitcoin OHLC');
    const ohlc = ex.find(e => e.term === 'ohlc');
    const bitcoin = ex.find(e => e.term === 'bitcoin');
    expect(ohlc).toBeTruthy();
    expect(bitcoin).toBeTruthy();
    expect(ohlc!.contribution).toBeGreaterThan(bitcoin!.contribution);
  });

  it('terms not present in doc are absent from explain', () => {
    const ex = svc.explain(2, 'bitcoin OHLC');
    expect(ex.map(e => e.term)).toContain('bitcoin');
    expect(ex.map(e => e.term)).not.toContain('ohlc');
  });
});

describe('Phase 12.2 — Bm25Service.stats', () => {
  it('reports vocab + docCount + avgDocLength', () => {
    const svc = new Bm25Service();
    svc.buildIndex([
      { id: 1, text: 'one two three' },
      { id: 2, text: 'two three four five' },
    ]);
    const s = svc.stats();
    expect(s.docCount).toBe(2);
    expect(s.avgDocLength).toBeCloseTo(3.5, 5);
    // unique non-stopword terms: one, two, three, four, five
    expect(s.vocabSize).toBe(5);
  });
});

describe('Phase 12.2 — performance smoke', () => {
  it('192-doc index builds in <50ms', () => {
    const docs = [];
    for (let i = 0; i < 192; i += 1) {
      docs.push({ id: i, text: `endpoint ${i} bitcoin lightning api category data finance` });
    }
    const svc = new Bm25Service();
    const t0 = performance.now();
    svc.buildIndex(docs);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(50);
  });

  it('192-doc topK runs in <10ms', () => {
    const docs = [];
    for (let i = 0; i < 192; i += 1) {
      docs.push({ id: i, text: `endpoint ${i} bitcoin lightning api data finance ${i % 7}` });
    }
    const svc = new Bm25Service();
    svc.buildIndex(docs);
    const t0 = performance.now();
    for (let i = 0; i < 10; i += 1) svc.topK('bitcoin lightning', 10);
    const elapsed = performance.now() - t0;
    expect(elapsed / 10).toBeLessThan(10); // p_avg < 10ms
  });
});
