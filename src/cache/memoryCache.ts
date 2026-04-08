// Shared in-memory TTL cache with stale-while-revalidate semantics for hot read
// endpoints (stats, leaderboard). Rebuilds of these entries are expensive
// (15-25s on a loaded box) so we never make a real user wait: once a value has
// been cached, subsequent expirations serve the stale value immediately and
// kick off a background rebuild. Only the very first caller on an empty key
// pays the rebuild cost synchronously — and the startup warm-up handles that.
//
// Intentionally minimal: no LRU, no metrics, no persistence. Entries are few
// and small enough that the map stays bounded without eviction logic.

import { logger } from '../logger';

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

const store = new Map<string, CacheEntry<unknown>>();
/** Keys currently being refreshed in the background. Prevents thundering herd. */
const refreshing = new Set<string>();

/** Default TTL in milliseconds if none is supplied. */
export const DEFAULT_TTL_MS = 30_000;

/** Returns the cached value for the given key, or null if missing or expired.
 *  Does NOT consider stale entries — use getOrCompute for SWR semantics. */
export function get<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    store.delete(key);
    return null;
  }
  return entry.data as T;
}

/** Returns the cached value even if expired. Used internally by getOrCompute. */
export function getStale<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  return entry.data as T;
}

/** Stores a value under the given key with the supplied TTL. */
export function set<T>(key: string, data: T, ttlMs: number = DEFAULT_TTL_MS): void {
  store.set(key, { data, expiry: Date.now() + ttlMs });
}

/** Stale-while-revalidate: returns the cached value immediately if present,
 *  refreshing in the background if expired. Only the first caller on a cold
 *  key pays the rebuild cost synchronously. */
export function getOrCompute<T>(key: string, ttlMs: number, compute: () => T): T {
  const entry = store.get(key);
  const now = Date.now();

  if (entry && now <= entry.expiry) {
    // Fresh hit
    return entry.data as T;
  }

  if (entry) {
    // Stale hit — serve the stale data, refresh in the background
    if (!refreshing.has(key)) {
      refreshing.add(key);
      setImmediate(() => {
        try {
          const fresh = compute();
          store.set(key, { data: fresh, expiry: Date.now() + ttlMs });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ key, error: msg }, 'Cache background refresh failed — keeping stale entry');
        } finally {
          refreshing.delete(key);
        }
      });
    }
    return entry.data as T;
  }

  // Cold miss — no data at all, have to compute synchronously
  const fresh = compute();
  store.set(key, { data: fresh, expiry: Date.now() + ttlMs });
  return fresh;
}

/** Removes a specific cache entry. */
export function invalidate(key: string): void {
  store.delete(key);
}

/** Clears every entry. Primarily used in tests. */
export function clear(): void {
  store.clear();
  refreshing.clear();
}

/** Current number of entries. Primarily used in tests / debug. */
export function size(): number {
  return store.size;
}
