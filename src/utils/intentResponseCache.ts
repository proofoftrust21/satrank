// Phase 6.5 — cache idempotent in-memory pour les responses /api/intent.
//
// Key = sha256(canonical request JSON). TTL fixe par défaut (60s — le
// catalogue ne bouge pas plus rapidement que ça côté probe). LRU bounded
// pour empêcher la croissance illimitée sous load.
//
// Pas de cache si fresh=true (le caller a explicitement payé pour un probe
// sync ; servir un résultat caché violerait le contrat Mix A+D).
//
// Pure in-memory : pas de Redis, pas de cross-process sharing. Quand la
// scale justifiera un cache distribué, on swappera l'implémentation derrière
// la même interface.
import { sha256 } from './crypto';

export interface IntentCacheOptions {
  ttlSeconds?: number;
  maxEntries?: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  insertedAt: number;
}

const DEFAULT_TTL_SEC = 60;
const DEFAULT_MAX_ENTRIES = 500;

/** LRU + TTL cache. Eviction à l'insertion : si on dépasse maxEntries, on
 *  drop l'entrée la plus ancienne (FIFO insertion order — Map iteration
 *  natively respects insertion order). Reads ne réordonnent pas — c'est
 *  un FIFO+TTL plus que LRU strict, mais avec un TTL court (60s) la
 *  différence est négligeable. */
export class IntentResponseCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly ttlSec: number;
  private readonly maxEntries: number;
  // Métriques observabilité — exposables via /api/oracle/cache-stats si besoin.
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(opts: IntentCacheOptions = {}) {
    this.ttlSec = opts.ttlSeconds ?? DEFAULT_TTL_SEC;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** Computer une clé canonique à partir d'un objet JSON. Trier les keys
   *  pour que `{a:1,b:2}` et `{b:2,a:1}` produisent le même hash. */
  static canonicalKey(input: unknown): string {
    return sha256(canonicalize(input));
  }

  get(key: string, nowSec?: number): T | null {
    const now = nowSec ?? Math.floor(Date.now() / 1000);
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    if (entry.expiresAt < now) {
      this.entries.delete(key);
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    return entry.value;
  }

  set(key: string, value: T, nowSec?: number): void {
    const now = nowSec ?? Math.floor(Date.now() / 1000);
    this.entries.set(key, {
      value,
      expiresAt: now + this.ttlSec,
      insertedAt: now,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.evictions += 1;
    }
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  stats(): { hits: number; misses: number; evictions: number; size: number } {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.entries.size,
    };
  }
}

/** Sérialise un objet de manière déterministe (clés triées, undefined
 *  exclus, arrays préservés). Garantit que des objets équivalents sémantiquement
 *  produisent la même string → même hash. */
function canonicalize(input: unknown): string {
  if (input === null) return 'null';
  if (input === undefined) return 'undefined';
  if (typeof input === 'string') return JSON.stringify(input);
  if (typeof input === 'number') return String(input);
  if (typeof input === 'boolean') return input ? 'true' : 'false';
  if (Array.isArray(input)) {
    return '[' + input.map(canonicalize).join(',') + ']';
  }
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys
      .filter((k) => obj[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k]));
    return '{' + parts.join(',') + '}';
  }
  return JSON.stringify(input);
}
