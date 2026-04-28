// Phase 6.5 — IntentResponseCache : tests purs LRU + TTL.
import { describe, it, expect } from 'vitest';
import { IntentResponseCache } from '../utils/intentResponseCache';

describe('IntentResponseCache', () => {
  it('returns null on miss', () => {
    const cache = new IntentResponseCache<string>();
    expect(cache.get('missing-key')).toBeNull();
  });

  it('returns stored value before TTL expires', () => {
    const cache = new IntentResponseCache<string>({ ttlSeconds: 60 });
    const t0 = 1_700_000_000;
    cache.set('k', 'value-1', t0);
    expect(cache.get('k', t0 + 30)).toBe('value-1');
  });

  it('returns null after TTL expires', () => {
    const cache = new IntentResponseCache<string>({ ttlSeconds: 60 });
    const t0 = 1_700_000_000;
    cache.set('k', 'value-1', t0);
    expect(cache.get('k', t0 + 61)).toBeNull();
  });

  it('LRU eviction when maxEntries exceeded', () => {
    const cache = new IntentResponseCache<number>({ maxEntries: 3 });
    const t0 = 1_700_000_000;
    cache.set('a', 1, t0);
    cache.set('b', 2, t0);
    cache.set('c', 3, t0);
    expect(cache.get('a', t0)).toBe(1);
    cache.set('d', 4, t0); // evicts oldest = 'a' (FIFO insertion order)
    expect(cache.get('a', t0)).toBeNull();
    expect(cache.get('d', t0)).toBe(4);
    expect(cache.stats().evictions).toBe(1);
  });

  it('canonicalKey is order-independent for object keys', () => {
    const k1 = IntentResponseCache.canonicalKey({ a: 1, b: 2, c: 3 });
    const k2 = IntentResponseCache.canonicalKey({ c: 3, b: 2, a: 1 });
    expect(k1).toBe(k2);
  });

  it('canonicalKey distinguishes different values', () => {
    const k1 = IntentResponseCache.canonicalKey({ a: 1 });
    const k2 = IntentResponseCache.canonicalKey({ a: 2 });
    expect(k1).not.toBe(k2);
  });

  it('canonicalKey ignores undefined fields (Mix A+D semantics)', () => {
    const k1 = IntentResponseCache.canonicalKey({ a: 1, b: undefined });
    const k2 = IntentResponseCache.canonicalKey({ a: 1 });
    expect(k1).toBe(k2);
  });

  it('canonicalKey handles arrays + nested objects', () => {
    const k1 = IntentResponseCache.canonicalKey({
      keywords: ['x', 'y'],
      nested: { p: 1, q: 2 },
    });
    const k2 = IntentResponseCache.canonicalKey({
      nested: { q: 2, p: 1 },
      keywords: ['x', 'y'],
    });
    expect(k1).toBe(k2);
  });

  it('stats track hits / misses / evictions / size', () => {
    const cache = new IntentResponseCache<number>({ maxEntries: 2 });
    const t0 = 1_700_000_000;
    cache.set('a', 1, t0);
    cache.get('a', t0); // hit
    cache.get('missing', t0); // miss
    cache.set('b', 2, t0);
    cache.set('c', 3, t0); // evicts 'a'
    const s = cache.stats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
    expect(s.evictions).toBe(1);
    expect(s.size).toBe(2);
  });

  it('clear() resets state', () => {
    const cache = new IntentResponseCache<number>();
    cache.set('a', 1);
    cache.get('a');
    cache.clear();
    expect(cache.get('a')).toBeNull();
    const s = cache.stats();
    expect(s.size).toBe(0);
    expect(s.hits).toBe(0);
    expect(s.misses).toBe(1); // miss vient du get post-clear
  });
});
