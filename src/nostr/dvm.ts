// NIP-90 Data Vending Machine — responds to trust-check job requests on Nostr
// Agents publish kind 5900 with tag ["j", "trust-check"] and ["i", "<ln_pubkey>", "text"]
// SatRank responds with kind 6900 containing the canonical Bayesian block +
// reachability. Composite score + scoreBreakdown retired in Phase 3.
// nostr-tools is ESM-only — all imports are dynamic
import type { AgentRepository } from '../repositories/agentRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { BayesianVerdictService } from '../services/bayesianVerdictService';
import type { LndGraphClient } from '../crawler/lndGraphClient';
import type { BayesianScoreBlock } from '../types';
import { logger } from '../logger';
import { verdictTotal } from '../middleware/metrics';

const KIND_JOB_REQUEST = 5900;
const KIND_JOB_RESULT = 6900;
const KIND_HANDLER_INFO = 31990;
const JOB_TYPE = 'trust-check';
const QUERY_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;

// Relays whose strfry config requires NIP-13 proof-of-work on kind 6900
// (the DVM job result kind). Inline mining for the documented 28-bit
// target is impractical inside a sub-3 s response budget — empirically
// ~140 k attempts/sec single-thread on the prod box, so 28 bits ≈ several
// minutes of mining per response. We continue to *subscribe* to these
// relays for incoming kind 5900 jobs (read path is fine), and just
// exclude them from the publish fan-out for kind 6900 so the logs stop
// flooding with "pow: N bits needed" rejections that an operator can't
// fix in real time. Requesters still receive responses via every other
// canonical relay we publish to.
const RELAYS_REQUIRING_KIND_6900_POW = new Set<string>([
  'wss://nos.lol',
]);

export interface DvmOptions {
  privateKeyHex: string;
  relays: string[];
}

// Active connected relay — the DVM tracks every open relay so a response
// can be fanned out to all of them, not just the one that delivered the
// job request. This is the fix for the nos.lol 28-bit PoW issue: that
// relay rejects unmined responses, but damus.io and relay.primal.net
// accept them, so publishing to all three guarantees the requester gets
// at least one response regardless of which relay delivered the job.
interface ActiveRelay {
  url: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  relay: any;
}

// Backoff schedule (ms) for our own manual reconnect — used when nostr-tools'
// built-in reconnect is exhausted or skipped (e.g. initial connect failure
// sets `skipReconnection=true` inside the lib so it never retries).
// Capped at 60s for the long tail.
const MANUAL_RECONNECT_BACKOFF_MS: number[] = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

// Reconnect attempts above this count log at WARN instead of INFO so a
// long-running outage surfaces in monitoring.
const MANUAL_RECONNECT_WARN_THRESHOLD = 5;

export class SatRankDvm {
  private skHex: string;
  private relays: string[];
  private running = false;
  private active: ActiveRelay[] = [];
  // Deduplicate requests that arrive via multiple relays — each relay
  // forwards the same event id to its own subscription, and without this
  // the DVM would process and respond to the same job N times.
  // Time-bounded Map (event_id → timestamp) instead of unbounded Set:
  // entries older than 5 minutes are pruned on each new request, which
  // both caps memory and provides a predictable dedup window.
  private seenRequests = new Map<string, number>();

  // Per-relay reconnect bookkeeping. Each relay has its own attempt counter
  // and its own pending timer; both are cleared on successful subscribe.
  private reconnectAttempts = new Map<string, number>();
  private reconnectTimers = new Map<string, NodeJS.Timeout>();

  // Imported once at start() time and reused for every reconnect cycle so
  // we don't pay the dynamic-import cost on each retry. Set in start().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private finalizeEvent: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private RelayClass: any = null;
  private mySk: Uint8Array | null = null;
  private myPubkey: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlerInfo: any = null;

  constructor(
    private agentRepo: AgentRepository,
    private probeRepo: ProbeRepository,
    private bayesianVerdict: BayesianVerdictService,
    private lndClient: LndGraphClient | undefined,
    options: DvmOptions,
  ) {
    this.skHex = options.privateKeyHex;
    this.relays = options.relays;
  }

  /** Canonical public Bayesian block for the given pubkey hash.
   *  Mirrors AgentService.toBayesianBlock — duplicated here to keep the DVM
   *  self-contained in the Nostr module (no dependency back onto the HTTP
   *  service layer). */
  private toBayesianBlock(publicKeyHash: string): BayesianScoreBlock {
    const v = this.bayesianVerdict.buildVerdict({ targetHash: publicKeyHash });
    return {
      p_success: v.p_success,
      ci95_low: v.ci95_low,
      ci95_high: v.ci95_high,
      n_obs: v.n_obs,
      verdict: v.verdict,
      window: v.window,
      sources: v.sources,
      convergence: v.convergence,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // @ts-expect-error — moduleResolution "node" can't resolve ESM subpath
    const { finalizeEvent, getPublicKey } = await import('nostr-tools/pure');
    // @ts-expect-error — moduleResolution "node" can't resolve ESM subpath
    const { Relay } = await import('nostr-tools/relay');
    const { hexToBytes } = await import('@noble/hashes/utils');

    const sk = hexToBytes(this.skHex);
    const myPubkey = getPublicKey(sk);

    // Publish handler info (NIP-89) so clients can discover this DVM
    const handlerInfo = finalizeEvent({
      kind: KIND_HANDLER_INFO,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['k', String(KIND_JOB_REQUEST)],
        ['d', 'satrank-trust-check'],
        ['t', 'lightning'],
        ['t', 'trust'],
        ['t', 'web-of-trust'],
      ],
      content: JSON.stringify({
        name: 'SatRank Trust Check',
        about: 'Lightning node trust scoring. Returns a Bayesian Beta-Binomial posterior (verdict + p_success + ci95 + n_obs) and reachability for any Lightning node pubkey.',
        website: 'https://satrank.dev',
      }),
    }, sk);

    // Cache imports + identity for the lifetime of the DVM so reconnect
    // cycles don't pay the dynamic-import cost or re-derive the pubkey.
    this.finalizeEvent = finalizeEvent;
    this.RelayClass = Relay;
    this.mySk = sk;
    this.myPubkey = myPubkey;
    this.handlerInfo = handlerInfo;

    // Connect to relays and subscribe
    for (const url of this.relays) {
      this.connectRelay(url);
    }

    logger.info({ relays: this.relays }, 'DVM started — listening for trust-check job requests');
  }

  // Schedule a manual reconnect for a relay using exponential backoff. Used
  // when nostr-tools' built-in reconnect is exhausted (relay.onclose fires
  // after the lib gives up) or when the very first connect attempt fails
  // (the lib forces skipReconnection=true on initial-connect errors).
  private scheduleReconnect(url: string): void {
    if (!this.running) return;
    // Drop any previous pending timer for this URL — only one reconnect in
    // flight at a time per relay.
    const existing = this.reconnectTimers.get(url);
    if (existing) clearTimeout(existing);

    const attempts = (this.reconnectAttempts.get(url) ?? 0) + 1;
    this.reconnectAttempts.set(url, attempts);

    const backoffMs = MANUAL_RECONNECT_BACKOFF_MS[
      Math.min(attempts - 1, MANUAL_RECONNECT_BACKOFF_MS.length - 1)
    ];

    const logFn = attempts >= MANUAL_RECONNECT_WARN_THRESHOLD ? logger.warn : logger.info;
    logFn.call(logger, { relay: url, attempt: attempts, backoffMs }, 'DVM manual reconnect scheduled');

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(url);
      this.connectRelay(url);
    }, backoffMs);
    // Don't keep the event loop alive solely for a pending reconnect.
    timer.unref?.();
    this.reconnectTimers.set(url, timer);
  }

  // Remove a relay from the active fan-out list and close it cleanly.
  private removeActive(url: string): void {
    const idx = this.active.findIndex((a) => a.url === url);
    if (idx >= 0) {
      const [removed] = this.active.splice(idx, 1);
      try { removed.relay.close(); } catch { /* ignore */ }
    }
  }

  private async connectRelay(url: string): Promise<void> {
    if (!this.running || !this.RelayClass || !this.mySk || !this.myPubkey || !this.handlerInfo || !this.finalizeEvent) {
      return;
    }
    // Drop any stale active entry for this URL before reconnecting (this
    // can happen if onclose fires while a parallel reconnect is already
    // mid-flight).
    this.removeActive(url);

    let relay: { publish: (e: unknown) => Promise<unknown>; subscribe: (filters: unknown[], params: unknown) => unknown; close: () => void; onclose: (() => void) | null } | null = null;
    try {
      relay = await Promise.race([
        // enablePing keeps the WS alive with periodic pings; enableReconnect
        // makes nostr-tools auto-reconnect on transient drops with its own
        // backoff. We still hook relay.onclose below to handle the case
        // where the lib gives up (skipReconnection on initial failure or
        // exhausted retries).
        this.RelayClass.connect(url, { enablePing: true, enableReconnect: true }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), CONNECT_TIMEOUT_MS)),
      ]) as typeof relay;

      // Register as an active relay so responses can be fanned out to
      // every connected relay regardless of which one delivered the job.
      this.active.push({ url, relay });

      // Hook relay-level onclose: nostr-tools fires this only when its
      // built-in reconnect is exhausted OR has been skipped. Either way,
      // we need to take over and retry on our own backoff schedule.
      relay!.onclose = () => {
        if (!this.running) return;
        logger.warn({ relay: url }, 'DVM relay closed (lib reconnect exhausted) — scheduling manual reconnect');
        this.removeActive(url);
        this.scheduleReconnect(url);
      };

      // Publish handler info on every (re)connect so newer relay snapshots
      // also see the NIP-89 advertisement.
      try {
        await relay!.publish(this.handlerInfo);
        logger.info({ relay: url }, 'DVM handler info published');
      } catch {
        logger.warn({ relay: url }, 'Failed to publish DVM handler info');
      }

      // Subscribe to job requests. The subscription's onclose fires if the
      // sub is closed for any reason (relay sent CLOSED, filter rejected,
      // etc.) — log it for diagnostics. The relay-level onclose handler
      // above is what triggers the actual reconnect.
      const myPubkey = this.myPubkey!;
      relay!.subscribe(
        [{ kinds: [KIND_JOB_REQUEST], '#j': [JOB_TYPE], since: Math.floor(Date.now() / 1000) }],
        {
          onevent: (event: { id: string; pubkey: string; tags: string[][]; content: string }) => {
            // Ignore own events
            if (event.pubkey === myPubkey) return;
            this.handleJobRequest(event, this.mySk!, this.finalizeEvent, url);
          },
          onclose: (reason: string) => {
            logger.warn({ relay: url, reason }, 'DVM subscription closed');
          },
        },
      );

      // Successful subscribe — reset the manual-reconnect attempt counter
      // so the next failure restarts at the shortest backoff.
      this.reconnectAttempts.delete(url);
      logger.info({ relay: url }, 'DVM subscribed to trust-check jobs');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ relay: url, error: msg }, 'DVM failed to connect to relay — scheduling manual reconnect');
      // Make sure no half-open Relay reference lingers
      if (relay) {
        try { (relay as { close: () => void }).close(); } catch { /* ignore */ }
      }
      this.removeActive(url);
      this.scheduleReconnect(url);
    }
  }

  private async handleJobRequest(
    event: { id: string; pubkey: string; tags: string[][]; content: string },
    sk: Uint8Array,
    finalizeEvent: (...args: unknown[]) => unknown,
    arrivedVia: string,
  ): Promise<void> {
    // Dedupe: a job can be forwarded by multiple relays; process and
    // respond exactly once. Time-bounded: entries older than 5 minutes
    // are pruned so memory stays bounded and the dedup window is predictable.
    const DEDUP_WINDOW_MS = 5 * 60 * 1000;
    const now = Date.now();
    if (this.seenRequests.has(event.id)) {
      logger.debug({ eventId: event.id.slice(0, 12), relay: arrivedVia }, 'DVM job request duplicate — ignored');
      return;
    }
    this.seenRequests.set(event.id, now);
    // Prune expired entries on each new request — O(N) but N ≤ ~1000 in practice
    for (const [id, ts] of this.seenRequests) {
      if (now - ts > DEDUP_WINDOW_MS) this.seenRequests.delete(id);
    }

    const iTag = event.tags.find(t => t[0] === 'i');
    if (!iTag || !iTag[1]) {
      logger.warn({ eventId: event.id.slice(0, 12) }, 'DVM job request missing input tag');
      return;
    }

    const lnPubkey = iTag[1];
    if (!/^(02|03)[a-f0-9]{64}$/.test(lnPubkey)) {
      logger.warn({ eventId: event.id.slice(0, 12), input: lnPubkey.slice(0, 16) }, 'DVM job request invalid pubkey format');
      return;
    }

    logger.info({ eventId: event.id.slice(0, 12), pubkey: lnPubkey.slice(0, 12), requester: event.pubkey.slice(0, 12), relay: arrivedVia }, 'DVM job request received');

    let result: Awaited<ReturnType<typeof this.processRequest>>;
    try {
      result = await Promise.race([
        this.processRequest(lnPubkey),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Processing timeout')), QUERY_TIMEOUT_MS)),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ eventId: event.id.slice(0, 12), error: msg }, 'DVM job processing failed');
      return;
    }

    const response = finalizeEvent({
      kind: KIND_JOB_RESULT,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['e', event.id],
        ['p', event.pubkey],
        ['request', JSON.stringify(event)],
      ],
      content: JSON.stringify(result),
    }, sk);

    // Fan-out: publish the response via a FRESH connection per relay.
    // We can't reuse `this.active` for publishing because nostr-tools'
    // Relay class auto-closes idle connections after a while — we saw
    // this in prod where the subscribe-time connection was already
    // closed by the time a job request arrived minutes later, and
    // nostr-tools threw "Tried to send message on a closed connection".
    // Opening a fresh connection per publish costs ~50 ms extra but is
    // bulletproof.
    //
    // We exclude any relay listed in RELAYS_REQUIRING_KIND_6900_POW from
    // the publish set — those relays would always reject the response
    // with "pow: N bits needed" and the inline mining cost is well over
    // the DVM SLA. The subscribe path keeps them in the listening loop
    // so we still receive jobs via those relays, we just respond via
    // the others.
    const publishTargets = this.relays.filter((url) => !RELAYS_REQUIRING_KIND_6900_POW.has(url));
    const skipped = this.relays.filter((url) => RELAYS_REQUIRING_KIND_6900_POW.has(url));
    // @ts-expect-error — nostr-tools is ESM-only, dynamic import at runtime
    const { Relay: RelayClass } = await import('nostr-tools/relay');
    const PUBLISH_TIMEOUT_MS = 5_000;
    const attempts = await Promise.allSettled(
      publishTargets.map(async (url) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let relay: any = null;
        try {
          relay = await Promise.race([
            RelayClass.connect(url),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('connect timeout')), CONNECT_TIMEOUT_MS)),
          ]);
          await Promise.race([
            relay.publish(response),
            new Promise((_, reject) => setTimeout(() => reject(new Error('publish timeout')), PUBLISH_TIMEOUT_MS)),
          ]);
          return { url, ok: true as const };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { url, ok: false as const, error: msg };
        } finally {
          if (relay) {
            try { relay.close(); } catch { /* ignore */ }
          }
        }
      }),
    );

    const published: string[] = [];
    const rejected: { url: string; error: string }[] = [];
    for (const a of attempts) {
      if (a.status === 'fulfilled') {
        if (a.value.ok) published.push(a.value.url);
        else rejected.push({ url: a.value.url, error: a.value.error });
      }
    }

    if (published.length > 0) {
      logger.info(
        {
          eventId: event.id.slice(0, 12),
          pubkey: lnPubkey.slice(0, 12),
          verdict: result.verdict,
          pSuccess: result.bayesian?.p_success ?? null,
          nObs: result.bayesian?.n_obs ?? null,
          source: result.source,
          publishedTo: published,
          rejectedBy: rejected.length ? rejected : undefined,
          skippedRelays: skipped.length ? skipped : undefined,
        },
        'DVM job result published',
      );
    } else {
      logger.error(
        {
          eventId: event.id.slice(0, 12),
          rejectedBy: rejected,
        },
        'DVM job result rejected by every relay — response not delivered',
      );
    }
  }

  private async processRequest(lnPubkey: string): Promise<{
    pubkey: string;
    alias: string | null;
    // bayesian is null only on the live_ping fallback (unknown pubkey, no
    // posterior data at all — synthesizing one would misrepresent evidence).
    bayesian: BayesianScoreBlock | null;
    reachable: boolean | null;
    source: 'index' | 'live_ping';
    // Surfaces the verdict on the live_ping branch where `bayesian` is null
    // (route probe result). Duplicates `bayesian.verdict` on the index branch.
    verdict: BayesianScoreBlock['verdict'];
  }> {
    const { sha256 } = await import('../utils/crypto');
    const hash = sha256(lnPubkey);
    const agent = this.agentRepo.findByHash(hash);

    if (agent) {
      const bayesian = this.toBayesianBlock(hash);
      const probe = this.probeRepo.findLatestAtTier(hash, 1000);
      const reachable = probe ? probe.reachable === 1 : null;
      verdictTotal.inc({ verdict: bayesian.verdict, source: 'dvm' });

      return {
        pubkey: lnPubkey,
        alias: agent.alias,
        bayesian,
        reachable,
        source: 'index',
        verdict: bayesian.verdict,
      };
    }

    // Unknown node — live ping via QueryRoutes. No posterior data to emit.
    if (this.lndClient) {
      try {
        const response = await this.lndClient.queryRoutes(lnPubkey, 1000);
        const routes = response.routes ?? [];
        const hasRoute = routes.length > 0;
        const verdict: BayesianScoreBlock['verdict'] = hasRoute ? 'UNKNOWN' : 'RISKY';
        verdictTotal.inc({ verdict, source: 'dvm' });

        return {
          pubkey: lnPubkey,
          alias: null,
          bayesian: null,
          reachable: hasRoute,
          source: 'live_ping',
          verdict,
        };
      } catch {
        verdictTotal.inc({ verdict: 'RISKY', source: 'dvm' });
        return {
          pubkey: lnPubkey,
          alias: null,
          bayesian: null,
          reachable: false,
          source: 'live_ping',
          verdict: 'RISKY',
        };
      }
    }

    verdictTotal.inc({ verdict: 'UNKNOWN', source: 'dvm' });
    return {
      pubkey: lnPubkey,
      alias: null,
      bayesian: null,
      reachable: null,
      source: 'live_ping',
      verdict: 'UNKNOWN',
    };
  }

  stop(): void {
    this.running = false;
    // Cancel any pending manual reconnect timers so we don't fire them
    // after stop().
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();
    // Close every active relay so the underlying WebSockets release.
    for (const a of this.active) {
      try { a.relay.close(); } catch { /* ignore */ }
    }
    this.active = [];
    logger.info('DVM stopped');
  }
}
