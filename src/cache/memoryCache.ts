// Shared in-memory TTL cache with stale-while-revalidate semantics for hot read
// endpoints (stats, leaderboard). Rebuilds of these entries are expensive
// (15-25s on a loaded box) so we never make a real user wait: once a value has
// been cached, subsequent expirations serve the stale value immediately and
// kick off a background rebuild. Only the very first caller on an empty key
// pays the rebuild cost synchronously — and the startup warm-up handles that.
//
// LRU eviction at MAX_ENTRIES prevents unbounded memory growth from dynamic
// cache keys (e.g. per-query variants of /agents/top?sort_by=X).

import { logger } from '../logger';
import { cacheEvents } from '../middleware/metrics';

interface CacheEntry<T> {
  data: T;
  expiry: number;
  lastAccess: number;
}

const MAX_ENTRIES = 500;
const store = new Map<string, CacheEntry<unknown>>();

/** Namespace prefix from the cache key (everything before the first ':'). */
function ns(key: string): string {
  const i = key.indexOf(':');
  return i === -1 ? key : key.slice(0, i);
}
/** Keys currently being refreshed in the background. Prevents thundering herd. */
const refreshing = new Set<string>();

/** Default TTL in milliseconds if none is supplied. */
export const DEFAULT_TTL_MS = 30_000;

/** Returns the cached value for the given key, or null if missing or expired.
 *  Does NOT consider stale entries — use getOrCompute for SWR semantics. */
export function get<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) { cacheEvents.inc({ namespace: ns(key), event: 'miss' }); return null; }
  if (Date.now() > entry.expiry) {
    store.delete(key);
    cacheEvents.inc({ namespace: ns(key), event: 'miss' });
    return null;
  }
  entry.lastAccess = Date.now();
  cacheEvents.inc({ namespace: ns(key), event: 'hit' });
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
  store.set(key, { data, expiry: Date.now() + ttlMs, lastAccess: Date.now() });
  evictIfNeeded();
}

/** LRU eviction: when store exceeds MAX_ENTRIES, remove least-recently-accessed entries. */
function evictIfNeeded(): void {
  if (store.size <= MAX_ENTRIES) return;
  // Sort entries by lastAccess ascending, remove the oldest
  const entries = [...store.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  const toRemove = entries.length - MAX_ENTRIES;
  for (let i = 0; i < toRemove; i++) {
    store.delete(entries[i][0]);
  }
}

/** Stale-while-revalidate: returns the cached value immediately if present,
 *  refreshing in the background if expired. Only the first caller on a cold
 *  key pays the rebuild cost synchronously. */
export function getOrCompute<T>(key: string, ttlMs: number, compute: () => T): T {
  const entry = store.get(key);
  const now = Date.now();

  if (entry && now <= entry.expiry) {
    // Fresh hit
    entry.lastAccess = now;
    return entry.data as T;
  }

  if (entry) {
    // Stale hit — serve the stale data, refresh in the background
    if (!refreshing.has(key)) {
      refreshing.add(key);
      setImmediate(() => {
        try {
          const fresh = compute();
          store.set(key, { data: fresh, expiry: Date.now() + ttlMs, lastAccess: Date.now() });
          evictIfNeeded();
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
  store.set(key, { data: fresh, expiry: Date.now() + ttlMs, lastAccess: Date.now() });
  evictIfNeeded();
  return fresh;
}

/** Async variant of getOrCompute — for queries that return Promise. */
export async function getOrComputeAsync<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const entry = store.get(key);
  const now = Date.now();

  if (entry && now <= entry.expiry) {
    entry.lastAccess = now;
    cacheEvents.inc({ namespace: ns(key), event: 'hit' });
    return entry.data as T;
  }

  if (entry) {
    // Stale — return immediately, refresh in background
    cacheEvents.inc({ namespace: ns(key), event: 'stale_hit' });
    if (!refreshing.has(key)) {
      refreshing.add(key);
      compute()
        .then(fresh => {
          store.set(key, { data: fresh, expiry: Date.now() + ttlMs, lastAccess: Date.now() });
          evictIfNeeded();
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ key, error: msg }, 'Async cache background refresh failed');
        })
        .finally(() => refreshing.delete(key));
    }
    return entry.data as T;
  }

  cacheEvents.inc({ namespace: ns(key), event: 'miss' });
  const fresh = await compute();
  store.set(key, { data: fresh, expiry: Date.now() + ttlMs, lastAccess: Date.now() });
  evictIfNeeded();
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
