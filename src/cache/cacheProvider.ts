// Cache abstraction — allows swapping memoryCache for Redis/Memcached
// without touching call sites. Contract is intentionally minimal.
//
// Current implementation: memoryCache (in-process LRU with stale-while-revalidate).
// Future drop-in: RedisProvider with same interface.

export interface CacheProvider {
  /** Fresh hit only — returns null if missing or expired. */
  get<T>(key: string): T | null;

  /** Returns value even if expired. Used for stale-while-revalidate. */
  getStale<T>(key: string): T | null;

  /** Stores under key with TTL (ms). */
  set<T>(key: string, value: T, ttlMs?: number): void;

  /** Stale-while-revalidate: fresh hit returns immediately;
   *  expired hit returns stale value and refreshes in background;
   *  cold miss computes synchronously. */
  getOrCompute<T>(key: string, ttlMs: number, compute: () => T): T;

  /** Async variant of getOrCompute — for queries that return Promise. */
  getOrComputeAsync<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T>;

  /** Remove a specific key. */
  invalidate(key: string): void;

  /** Clear everything — primarily for tests. */
  clear(): void;

  /** Current entry count — for observability. */
  size(): number;
}

/** Default cache provider — in-process memoryCache.
 *  To swap for Redis: replace this export with a RedisProvider instance. */
import * as memCache from './memoryCache';

export const cache: CacheProvider = {
  get: memCache.get,
  getStale: memCache.getStale,
  set: memCache.set,
  getOrCompute: memCache.getOrCompute,
  getOrComputeAsync: memCache.getOrComputeAsync,
  invalidate: memCache.invalidate,
  clear: memCache.clear,
  size: memCache.size,
};
