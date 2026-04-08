// Shared in-memory TTL cache used by hot read endpoints (stats, leaderboard).
// Intentionally minimal: no LRU, no metrics, no background refresh. The entries
// we cache are small and the TTL is short, so the map stays bounded in practice.
// For SWR semantics, see the warm-up pattern used at app startup.

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

const store = new Map<string, CacheEntry<unknown>>();

/** Default TTL in milliseconds if none is supplied. */
export const DEFAULT_TTL_MS = 30_000;

/** Returns the cached value for the given key, or null if missing or expired. */
export function get<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    store.delete(key);
    return null;
  }
  return entry.data as T;
}

/** Stores a value under the given key with the supplied TTL. */
export function set<T>(key: string, data: T, ttlMs: number = DEFAULT_TTL_MS): void {
  store.set(key, { data, expiry: Date.now() + ttlMs });
}

/** Removes a specific cache entry. */
export function invalidate(key: string): void {
  store.delete(key);
}

/** Clears every entry. Primarily used in tests. */
export function clear(): void {
  store.clear();
}

/** Current number of entries. Primarily used in tests / debug. */
export function size(): number {
  return store.size;
}
