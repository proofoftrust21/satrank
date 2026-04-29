// Phase 8.0 / 8.2 — generic Nostr subscriber.
//
// Subscribe permanent à un filter Nostr sur N relais. Dispatch chaque event
// reçu vers un handler async injecté. Pattern réutilisé pour kind 30784
// (oracle announcements) et kind 7402 (crowd outcome reports).
//
// Reconnect logic : matche le DVM pattern. Backoff exponentiel par relai,
// dedup events arrivés via plusieurs relais (Map event_id → ts, prune 5min).
import { logger } from '../logger';

const CONNECT_TIMEOUT_MS = 10_000;
const MANUAL_RECONNECT_BACKOFF_MS: number[] = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const DEDUP_WINDOW_MS = 5 * 60 * 1000;
// Security M3 — hard cap dedup Map size pour empêcher OOM sous burst
// volumique (10k events/sec saturent le pruning TTL avant prune).
// 50k × ~150 bytes ≈ 7.5 MB max, acceptable.
const DEDUP_MAX_ENTRIES = 50_000;
// Security C3 — hard cap event size avant dispatch. Au-delà = adversarial.
// 64KB matche la limite typique des relais Nostr (NIP-01 recommande
// 64-256KB max). Tout event au-dessus est silently dropped.
const MAX_EVENT_BYTES = 64 * 1024;

export interface NostrEventLike {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface NostrFilter {
  kinds: number[];
  '#d'?: string[];
  since?: number;
  authors?: string[];
}

export interface NostrEventSubscriberOptions {
  /** Friendly label pour les logs (ex. 'oracle-peers', 'crowd-outcomes'). */
  label: string;
  relays: string[];
  filters: NostrFilter[];
  /** Handler async invoked pour chaque event passing dedup. Erreurs sont
   *  loguées (non-fatal — le subscriber continue). */
  onEvent: (event: NostrEventLike, arrivedVia: string) => Promise<void>;
}

interface ActiveRelay {
  url: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  relay: any;
}

export class NostrEventSubscriber {
  private readonly label: string;
  private readonly relays: string[];
  private readonly filters: NostrFilter[];
  private readonly onEvent: NostrEventSubscriberOptions['onEvent'];
  private running = false;
  private active: ActiveRelay[] = [];
  private seen = new Map<string, number>();
  private reconnectAttempts = new Map<string, number>();
  private reconnectTimers = new Map<string, NodeJS.Timeout>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private RelayClass: any = null;

  constructor(opts: NostrEventSubscriberOptions) {
    this.label = opts.label;
    this.relays = opts.relays;
    this.filters = opts.filters;
    this.onEvent = opts.onEvent;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // @ts-expect-error — moduleResolution "node" can't resolve ESM subpath
    const { Relay } = await import('nostr-tools/relay');
    this.RelayClass = Relay;
    for (const url of this.relays) {
      this.connectAndSubscribe(url);
    }
    logger.info(
      { label: this.label, relays: this.relays, filters: this.filters },
      'NostrEventSubscriber started',
    );
  }

  stop(): void {
    this.running = false;
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();
    for (const a of this.active) {
      try { a.relay.close(); } catch { /* swallow */ }
    }
    this.active = [];
  }

  private async connectAndSubscribe(url: string): Promise<void> {
    if (!this.running || !this.RelayClass) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let relay: any = null;
    try {
      relay = await Promise.race([
        this.RelayClass.connect(url, { enablePing: true, enableReconnect: true }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('connect timeout')), CONNECT_TIMEOUT_MS),
        ),
      ]);
      this.active.push({ url, relay });

      // Subscription. The handler dedupes + dispatches.
      relay.subscribe(this.filters, {
        onevent: (event: NostrEventLike) => {
          this.handleEvent(event, url);
        },
        onclose: (reason: string) => {
          logger.warn({ label: this.label, relay: url, reason }, 'NostrEventSubscriber subscription closed');
        },
      });

      this.reconnectAttempts.delete(url);
      logger.info({ label: this.label, relay: url }, 'NostrEventSubscriber subscribed');

      // Hook close → manual reconnect (matche pattern DVM).
      const reconnectIfDown = () => {
        if (!this.running) return;
        if (relay && typeof relay.connected === 'boolean' && relay.connected) return;
        this.removeActive(url);
        this.scheduleReconnect(url);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = relay as any;
      if (typeof r.onclose === 'function') {
        const originalOnClose = r.onclose;
        r.onclose = (...args: unknown[]) => {
          try { originalOnClose.apply(r, args); } catch { /* swallow */ }
          reconnectIfDown();
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ label: this.label, relay: url, error: msg }, 'NostrEventSubscriber connect failed');
      if (relay) {
        try { (relay as { close: () => void }).close(); } catch { /* swallow */ }
      }
      this.removeActive(url);
      this.scheduleReconnect(url);
    }
  }

  private removeActive(url: string): void {
    this.active = this.active.filter((a) => a.url !== url);
  }

  private scheduleReconnect(url: string): void {
    if (!this.running) return;
    if (this.reconnectTimers.has(url)) return;
    const attempts = (this.reconnectAttempts.get(url) ?? 0) + 1;
    this.reconnectAttempts.set(url, attempts);
    const idx = Math.min(attempts - 1, MANUAL_RECONNECT_BACKOFF_MS.length - 1);
    const backoff = MANUAL_RECONNECT_BACKOFF_MS[idx];
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(url);
      this.connectAndSubscribe(url);
    }, backoff);
    timer.unref?.();
    this.reconnectTimers.set(url, timer);
  }

  private handleEvent(event: NostrEventLike, arrivedVia: string): void {
    // Security C3 — hard cap event size avant dispatch.
    const eventSize =
      (event.id?.length ?? 0) +
      (event.pubkey?.length ?? 0) +
      (event.sig?.length ?? 0) +
      (event.content?.length ?? 0) +
      (event.tags?.reduce((acc, t) => acc + t.reduce((a, s) => a + (s?.length ?? 0), 0), 0) ?? 0);
    if (eventSize > MAX_EVENT_BYTES) {
      logger.warn(
        { label: this.label, eventId: event.id?.slice(0, 12), size: eventSize, max: MAX_EVENT_BYTES },
        'NostrEventSubscriber dropped oversized event',
      );
      return;
    }
    // Dedup : même event délivré par plusieurs relais → traité 1 fois.
    const now = Date.now();
    if (this.seen.has(event.id)) return;
    this.seen.set(event.id, now);
    // Prune par TTL
    for (const [id, ts] of this.seen) {
      if (now - ts > DEDUP_WINDOW_MS) this.seen.delete(id);
    }
    // Security M3 — hard cap entries (defense-in-depth contre burst).
    // Si on est au-dessus du cap après TTL prune, drop FIFO les plus anciens.
    while (this.seen.size > DEDUP_MAX_ENTRIES) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    this.onEvent(event, arrivedVia).catch((err) => {
      logger.warn(
        { label: this.label, eventId: event.id.slice(0, 12), arrivedVia, error: err instanceof Error ? err.message : String(err) },
        'NostrEventSubscriber event handler failed',
      );
    });
  }

  /** Pour tests : nombre d'events vus distincts. */
  get seenCount(): number {
    return this.seen.size;
  }

  /** Pour tests : nombre de relais actuellement connectés. */
  get connectedRelayCount(): number {
    return this.active.length;
  }
}
