// Unit tests for the shared in-memory TTL cache
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as memoryCache from '../cache/memoryCache';

describe('memoryCache', () => {
  beforeEach(() => {
    memoryCache.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    memoryCache.clear();
  });

  it('returns null for a missing key', () => {
    expect(memoryCache.get('missing')).toBeNull();
  });

  it('stores and retrieves a value within the TTL', () => {
    memoryCache.set('k1', { score: 42 }, 1000);
    expect(memoryCache.get<{ score: number }>('k1')).toEqual({ score: 42 });
  });

  it('returns null and evicts the entry after the TTL elapses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-08T00:00:00Z'));
    memoryCache.set('k1', 'value', 1000);
    expect(memoryCache.get('k1')).toBe('value');

    vi.setSystemTime(new Date('2026-04-08T00:00:01.001Z'));
    expect(memoryCache.get('k1')).toBeNull();
    expect(memoryCache.size()).toBe(0);
  });

  it('invalidate removes a specific key without touching others', () => {
    memoryCache.set('a', 1);
    memoryCache.set('b', 2);
    memoryCache.invalidate('a');
    expect(memoryCache.get('a')).toBeNull();
    expect(memoryCache.get<number>('b')).toBe(2);
  });

  it('clear removes every entry', () => {
    memoryCache.set('a', 1);
    memoryCache.set('b', 2);
    memoryCache.clear();
    expect(memoryCache.size()).toBe(0);
  });

  it('defaults to a 30s TTL when none is supplied', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-08T00:00:00Z'));
    memoryCache.set('k', 'v');

    vi.setSystemTime(new Date('2026-04-08T00:00:29.999Z'));
    expect(memoryCache.get('k')).toBe('v');

    vi.setSystemTime(new Date('2026-04-08T00:00:30.001Z'));
    expect(memoryCache.get('k')).toBeNull();
  });

  it('isolates entries by key', () => {
    memoryCache.set('agents:top:10:0:score', { data: 'score-variant' });
    memoryCache.set('agents:top:10:0:reputation', { data: 'reputation-variant' });
    expect(memoryCache.get<{ data: string }>('agents:top:10:0:score')?.data).toBe('score-variant');
    expect(memoryCache.get<{ data: string }>('agents:top:10:0:reputation')?.data).toBe('reputation-variant');
  });

  describe('getOrCompute — stale-while-revalidate', () => {
    it('computes synchronously on cold miss and caches the result', () => {
      const compute = vi.fn(() => ({ count: 1 }));
      const result = memoryCache.getOrCompute('cold', 1000, compute);
      expect(result).toEqual({ count: 1 });
      expect(compute).toHaveBeenCalledTimes(1);
      // Subsequent fresh hit does not recompute
      const again = memoryCache.getOrCompute('cold', 1000, compute);
      expect(again).toEqual({ count: 1 });
      expect(compute).toHaveBeenCalledTimes(1);
    });

    it('serves stale value immediately on expiration and refreshes in background', async () => {
      vi.useFakeTimers({ toFake: ['Date'] }); // keep setImmediate real
      vi.setSystemTime(new Date('2026-04-08T00:00:00Z'));

      let version = 1;
      const compute = vi.fn(() => ({ version: version++ }));

      // Initial build
      expect(memoryCache.getOrCompute('swr', 1000, compute)).toEqual({ version: 1 });
      expect(compute).toHaveBeenCalledTimes(1);

      // Advance past TTL
      vi.setSystemTime(new Date('2026-04-08T00:00:01.500Z'));

      // Expired read returns the stale version immediately
      expect(memoryCache.getOrCompute('swr', 1000, compute)).toEqual({ version: 1 });

      // Background refresh runs on the next microtask tick
      await new Promise(resolve => setImmediate(resolve));

      // compute should have been called once more by the background refresh
      expect(compute).toHaveBeenCalledTimes(2);

      // The stored value is now the fresh version 2
      expect(memoryCache.getOrCompute('swr', 1000, compute)).toEqual({ version: 2 });
    });

    it('deduplicates concurrent background refreshes for the same key', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-04-08T00:00:00Z'));

      let counter = 0;
      const compute = vi.fn(() => ({ v: ++counter }));
      memoryCache.getOrCompute('dedup', 1000, compute);
      vi.setSystemTime(new Date('2026-04-08T00:00:01.500Z'));

      // Many simultaneous stale reads
      for (let i = 0; i < 5; i++) memoryCache.getOrCompute('dedup', 1000, compute);
      await new Promise(resolve => setImmediate(resolve));

      // Initial call + exactly one refresh, not five
      expect(compute).toHaveBeenCalledTimes(2);
    });

    it('keeps the stale entry if the background refresh throws', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-04-08T00:00:00Z'));

      let shouldThrow = false;
      const compute = vi.fn(() => {
        if (shouldThrow) throw new Error('DB down');
        return { value: 'ok' };
      });

      memoryCache.getOrCompute('throws', 1000, compute);
      vi.setSystemTime(new Date('2026-04-08T00:00:01.500Z'));

      shouldThrow = true;
      const stale = memoryCache.getOrCompute('throws', 1000, compute);
      expect(stale).toEqual({ value: 'ok' });
      await new Promise(resolve => setImmediate(resolve));

      // Stale entry is preserved even though the refresh failed
      expect(memoryCache.getStale('throws')).toEqual({ value: 'ok' });
    });
  });
});
