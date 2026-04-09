// NIP-90 Data Vending Machine — responds to trust-check job requests on Nostr
// Agents publish kind 5900 with tag ["j", "trust-check"] and ["i", "<ln_pubkey>", "text"]
// SatRank responds with kind 6900 containing score, verdict, reachability
// nostr-tools is ESM-only — all imports are dynamic
import type { AgentRepository } from '../repositories/agentRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { ScoringService } from '../services/scoringService';
import type { LndGraphClient } from '../crawler/lndGraphClient';
import { logger } from '../logger';
import { VERDICT_SAFE_THRESHOLD } from '../config/scoring';

const KIND_JOB_REQUEST = 5900;
const KIND_JOB_RESULT = 6900;
const KIND_HANDLER_INFO = 31990;
const JOB_TYPE = 'trust-check';
const QUERY_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;

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

export class SatRankDvm {
  private skHex: string;
  private relays: string[];
  private running = false;
  private active: ActiveRelay[] = [];
  // Deduplicate requests that arrive via multiple relays — each relay
  // forwards the same event id to its own subscription, and without this
  // the DVM would process and respond to the same job N times.
  private seenRequests = new Set<string>();

  constructor(
    private agentRepo: AgentRepository,
    private probeRepo: ProbeRepository,
    private snapshotRepo: SnapshotRepository,
    private scoringService: ScoringService,
    private lndClient: LndGraphClient | undefined,
    options: DvmOptions,
  ) {
    this.skHex = options.privateKeyHex;
    this.relays = options.relays;
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
        about: 'Lightning node trust scoring. Returns verdict, score, and reachability for any Lightning node pubkey.',
        website: 'https://satrank.dev',
      }),
    }, sk);

    // Connect to relays and subscribe
    for (const url of this.relays) {
      this.connectRelay(url, sk, myPubkey, finalizeEvent, Relay, handlerInfo);
    }

    logger.info({ relays: this.relays }, 'DVM started — listening for trust-check job requests');
  }

  private async connectRelay(
    url: string,
    sk: Uint8Array,
    myPubkey: string,
    finalizeEvent: (...args: unknown[]) => unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RelayClass: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handlerInfo: any,
  ): Promise<void> {
    try {
      const relay = await Promise.race([
        RelayClass.connect(url),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), CONNECT_TIMEOUT_MS)),
      ]);

      // Register as an active relay so responses can be fanned out to
      // every connected relay regardless of which one delivered the job.
      this.active.push({ url, relay });

      // Publish handler info
      try {
        await relay.publish(handlerInfo);
        logger.info({ relay: url }, 'DVM handler info published');
      } catch {
        logger.warn({ relay: url }, 'Failed to publish DVM handler info');
      }

      // Subscribe to job requests
      relay.subscribe(
        [{ kinds: [KIND_JOB_REQUEST], '#j': [JOB_TYPE], since: Math.floor(Date.now() / 1000) }],
        {
          onevent: (event: { id: string; pubkey: string; tags: string[][]; content: string }) => {
            // Ignore own events
            if (event.pubkey === myPubkey) return;

            this.handleJobRequest(event, sk, finalizeEvent, url);
          },
        },
      );

      logger.info({ relay: url }, 'DVM subscribed to trust-check jobs');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ relay: url, error: msg }, 'DVM failed to connect to relay — will retry on next start');
    }
  }

  private async handleJobRequest(
    event: { id: string; pubkey: string; tags: string[][]; content: string },
    sk: Uint8Array,
    finalizeEvent: (...args: unknown[]) => unknown,
    arrivedVia: string,
  ): Promise<void> {
    // Dedupe: a job can be forwarded by multiple relays; process and
    // respond exactly once.
    if (this.seenRequests.has(event.id)) {
      logger.debug({ eventId: event.id.slice(0, 12), relay: arrivedVia }, 'DVM job request duplicate — ignored');
      return;
    }
    this.seenRequests.add(event.id);
    // Cap the dedupe set so it doesn't grow unbounded over days of uptime
    if (this.seenRequests.size > 10_000) {
      const first = this.seenRequests.values().next().value as string | undefined;
      if (first) this.seenRequests.delete(first);
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
    // nos.lol enforces NIP-13 proof-of-work on kind 6900 events and will
    // reject unmined responses with "pow: 28 bits needed". That's OK as
    // long as at least one relay accepts.
    // @ts-expect-error — nostr-tools is ESM-only, dynamic import at runtime
    const { Relay: RelayClass } = await import('nostr-tools/relay');
    const PUBLISH_TIMEOUT_MS = 5_000;
    const attempts = await Promise.allSettled(
      this.relays.map(async (url) => {
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
          score: result.score,
          verdict: result.verdict,
          publishedTo: published,
          rejectedBy: rejected.length ? rejected : undefined,
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
    score: number | null;
    verdict: string;
    reachable: boolean | null;
    successRate: number | null;
    alias: string | null;
    source: 'index' | 'live_ping';
  }> {
    // Check if the node is in our index
    const { sha256 } = await import('../utils/crypto');
    const hash = sha256(lnPubkey);
    const agent = this.agentRepo.findByHash(hash);

    if (agent && agent.avg_score > 0) {
      // Known node — return score from index
      const scoreResult = this.scoringService.getScore(hash);
      const probe = this.probeRepo.findLatest(hash);
      const reachable = probe ? probe.reachable === 1 : null;
      const verdict = scoreResult.total >= VERDICT_SAFE_THRESHOLD ? 'SAFE' : scoreResult.total >= 30 ? 'UNKNOWN' : 'RISKY';

      return {
        pubkey: lnPubkey,
        score: scoreResult.total,
        verdict,
        reachable,
        successRate: null, // no reports yet
        alias: agent.alias,
        source: 'index',
      };
    }

    // Unknown node — live ping via QueryRoutes
    if (this.lndClient) {
      try {
        const response = await this.lndClient.queryRoutes(lnPubkey, 1000);
        const routes = response.routes ?? [];
        const hasRoute = routes.length > 0;

        return {
          pubkey: lnPubkey,
          score: null,
          verdict: hasRoute ? 'UNKNOWN' : 'RISKY',
          reachable: hasRoute,
          successRate: null,
          alias: null,
          source: 'live_ping',
        };
      } catch {
        return {
          pubkey: lnPubkey,
          score: null,
          verdict: 'RISKY',
          reachable: false,
          successRate: null,
          alias: null,
          source: 'live_ping',
        };
      }
    }

    // No LND — can't check
    return {
      pubkey: lnPubkey,
      score: null,
      verdict: 'UNKNOWN',
      reachable: null,
      successRate: null,
      alias: null,
      source: 'live_ping',
    };
  }

  stop(): void {
    this.running = false;
    logger.info('DVM stopped');
  }
}
