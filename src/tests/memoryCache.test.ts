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
});
