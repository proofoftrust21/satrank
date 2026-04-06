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

export class SatRankDvm {
  private skHex: string;
  private relays: string[];
  private running = false;

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

            this.handleJobRequest(event, sk, relay, finalizeEvent, url);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    relay: any,
    finalizeEvent: (...args: unknown[]) => unknown,
    relayUrl: string,
  ): Promise<void> {
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

    logger.info({ eventId: event.id.slice(0, 12), pubkey: lnPubkey.slice(0, 12), requester: event.pubkey.slice(0, 12), relay: relayUrl }, 'DVM job request received');

    try {
      const result = await Promise.race([
        this.processRequest(lnPubkey),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Processing timeout')), QUERY_TIMEOUT_MS)),
      ]);

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

      await relay.publish(response);
      logger.info({ eventId: event.id.slice(0, 12), pubkey: lnPubkey.slice(0, 12), score: result.score, verdict: result.verdict }, 'DVM job result published');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ eventId: event.id.slice(0, 12), error: msg }, 'DVM job processing failed');
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
      const verdict = scoreResult.total >= 50 ? 'SAFE' : scoreResult.total >= 30 ? 'UNKNOWN' : 'RISKY';

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
