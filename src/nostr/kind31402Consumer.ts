// Sim 8 follow-up (2026-04-30) — Nostr kind 31402 consumer.
//
// Subscribes to the experimental L402/x402 service announcement kind
// (forgesworn NIP draft PR #2291). Each event lists one operator endpoint
// with `url`, `name`, `pmi` (payment-method identifier — l402, x402,
// cashu, ...), and `price` tags. We ingest only Lightning-rail items
// (pmi includes 'l402' or 'lightning' — Lightning-pure decision 2026-04-30)
// and skip the forgesworn-crawler dupes (events whose `source` tag is
// 'crawl', which are re-publications of HTTP-discovered services that
// 402.pub indexes — those should reach SatRank via the registry crawler
// already, not as fresh discoveries).
//
// Net population observed 2026-04-30: 78 events / 15 distinct authors /
// ~14 organic operators. Yield will be small but the ingestion path
// keeps SatRank Nostr-native by listening to the L402-side of the
// 30000-29999 broadcast space (kind 30784 already consumed for oracle
// peers).
import { logger } from '../logger';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { RegistryCrawler, ProbeResult } from '../crawler/registryCrawler';
import { NostrEventSubscriber, type NostrEventLike } from './nostrEventSubscriber';
import { isSafeUrl } from '../utils/ssrf';
import { DEFAULT_NOSTR_RELAYS } from './relays';

const KIND_31402 = 31402;

/** Audit M2 — cap urls per event so a maximally-stuffed 64KB event can't
 *  fan out to ~1500 concurrent probeUrl calls. The forgesworn spec is
 *  per-operator-endpoint; 5 covers clearnet + .onion + .hns transports
 *  with headroom and blocks amplification attempts. */
const MAX_URLS_PER_EVENT = 5;

/** Lightweight signature-verification dependency. Mirrors the pattern in
 *  oraclePeersDiscovery / crowdOutcomeIngestor / operatorCrawler — every
 *  consumer of untrusted Nostr events injects verifyEvent so it can be
 *  stubbed under test. Audit M1 — without this, an attacker could spoof
 *  events from any pubkey on any relay and amplify probes against any
 *  public-internet host. */
type VerifyEvent = (event: NostrEventLike) => boolean;

export interface Kind31402ConsumerOptions {
  serviceEndpointRepo: ServiceEndpointRepository;
  registryCrawler: Pick<RegistryCrawler, 'probeUrl'>;
  /** Schnorr signature verifier. Required: events fail-closed if the verifier
   *  rejects, mirrors oracle-peers + crowd-outcomes hardening. */
  verifyEvent: VerifyEvent;
  relays?: readonly string[];
}

export interface Kind31402Stats {
  eventsReceived: number;
  eventsIgnoredBadSignature: number;
  eventsIgnoredCrawler: number;
  eventsIgnoredNonLightning: number;
  eventsIgnoredMalformed: number;
  eventsTruncatedUrls: number;
  urlsAttempted: number;
  urlsMergedExisting: number;
  urlsAlreadyAttributed: number;
  urlsDiscovered: number;
  urlsSkippedUnsafe: number;
  urlsSkippedTemplated: number;
  urlsProbeFailed: number;
}

function tagValue(tags: string[][], name: string): string | null {
  for (const t of tags) {
    if (Array.isArray(t) && t.length >= 2 && t[0] === name) return t[1];
  }
  return null;
}

function tagValues(tags: string[][], name: string): string[] {
  const out: string[] = [];
  for (const t of tags) {
    if (Array.isArray(t) && t.length >= 2 && t[0] === name) {
      // Some PMIs are comma-separated inside a single tag value; spec varies.
      const parts = String(t[1]).split(/[,\s]+/).filter(s => s.length > 0);
      out.push(...parts);
    }
  }
  return out;
}

function isTemplatedUrl(url: string): boolean {
  return /\{[^}]+\}/.test(url);
}

/** Determine whether the event's payment-method identifier set includes a
 *  Lightning rail. SatRank ingests only Lightning items (pure-Bitcoin
 *  decision 2026-04-30). The PMI vocabulary observed in the wild is
 *  `l402`, `lightning`, `x402`, `cashu`, `xcashu`, `payment` (generic). */
export function isLightningPmi(pmis: string[]): boolean {
  if (pmis.length === 0) return false;
  const norm = pmis.map(s => s.toLowerCase());
  return norm.some(p =>
    p === 'l402' ||
    p === 'lightning' ||
    p === 'bitcoin-lightning-bolt11' ||
    p === 'bolt11' ||
    p.startsWith('lightning-')
  );
}

export function isCrawlerOriginEvent(tags: string[][]): boolean {
  return tagValue(tags, 'source')?.toLowerCase() === 'crawl';
}

export class Kind31402Consumer {
  private subscriber: NostrEventSubscriber;
  private serviceEndpointRepo: ServiceEndpointRepository;
  private registryCrawler: Pick<RegistryCrawler, 'probeUrl'>;
  private verifyEvent: VerifyEvent;
  private stats: Kind31402Stats = this.emptyStats();

  constructor(opts: Kind31402ConsumerOptions) {
    this.serviceEndpointRepo = opts.serviceEndpointRepo;
    this.registryCrawler = opts.registryCrawler;
    this.verifyEvent = opts.verifyEvent;
    const relays = (opts.relays ?? DEFAULT_NOSTR_RELAYS).slice() as string[];
    this.subscriber = new NostrEventSubscriber({
      label: 'kind-31402',
      relays,
      filters: [{ kinds: [KIND_31402] }],
      // Audit INFO-1 — pass arrivedVia through so log entries can attribute
      // events to the relay that delivered them.
      onEvent: (ev, arrivedVia) => this.handleEvent(ev, arrivedVia),
    });
  }

  async start(): Promise<void> {
    await this.subscriber.start();
  }

  stop(): void {
    this.subscriber.stop();
  }

  /** Snapshot of cumulative stats since process start. Used by /api/health
   *  for observability. */
  getStats(): Readonly<Kind31402Stats> {
    return { ...this.stats };
  }

  private async handleEvent(event: NostrEventLike, arrivedVia?: string): Promise<void> {
    this.stats.eventsReceived++;

    // Audit M1 — verify Schnorr signature before any URL processing.
    // Fail-closed: a relay can't spoof events from any pubkey to amplify
    // probes against arbitrary internet hosts.
    let signatureOk = false;
    try {
      signatureOk = this.verifyEvent(event);
    } catch (err) {
      logger.warn(
        { eventId: event.id?.slice(0, 12), arrivedVia, error: err instanceof Error ? err.message : String(err) },
        'Kind31402Consumer: verifyEvent threw',
      );
    }
    if (!signatureOk) {
      this.stats.eventsIgnoredBadSignature++;
      return;
    }

    // Skip crawler-origin republications — those duplicate URLs already
    // discoverable via the HTTP-side crawler.
    if (isCrawlerOriginEvent(event.tags)) {
      this.stats.eventsIgnoredCrawler++;
      return;
    }

    const pmis = tagValues(event.tags, 'pmi');
    if (!isLightningPmi(pmis)) {
      this.stats.eventsIgnoredNonLightning++;
      return;
    }

    // Multiple `url` tags allowed (clearnet / .onion / .hns transports).
    // We ingest each clearnet HTTPS URL.
    const urlTagsAll: string[] = [];
    for (const t of event.tags) {
      if (Array.isArray(t) && t.length >= 2 && t[0] === 'url') {
        urlTagsAll.push(t[1]);
      }
    }
    if (urlTagsAll.length === 0) {
      this.stats.eventsIgnoredMalformed++;
      return;
    }
    // Audit M2 — cap URLs to bound probe fan-out per event. Forgesworn
    // events in the wild carry 1-3 transports; 5 leaves headroom.
    const urlTags = urlTagsAll.slice(0, MAX_URLS_PER_EVENT);
    if (urlTagsAll.length > MAX_URLS_PER_EVENT) {
      this.stats.eventsTruncatedUrls++;
      logger.warn(
        {
          eventId: event.id?.slice(0, 12),
          arrivedVia,
          urlCount: urlTagsAll.length,
          cap: MAX_URLS_PER_EVENT,
        },
        'Kind31402Consumer: event url tags truncated',
      );
    }

    for (const rawUrl of urlTags) {
      if (typeof rawUrl !== 'string' || !rawUrl.startsWith('https://')) {
        // Spec allows .onion / .hns; we only crawl clearnet HTTPS.
        continue;
      }
      this.stats.urlsAttempted++;

      if (isTemplatedUrl(rawUrl)) {
        this.stats.urlsSkippedTemplated++;
        continue;
      }
      if (!isSafeUrl(rawUrl)) {
        this.stats.urlsSkippedUnsafe++;
        continue;
      }

      try {
        const existing = await this.serviceEndpointRepo.findByUrl(rawUrl);
        if (existing) {
          const attached = await this.serviceEndpointRepo.attachSource(rawUrl, 'nostr_31402');
          if (attached.found && attached.added) {
            this.stats.urlsMergedExisting++;
          } else if (attached.found) {
            this.stats.urlsAlreadyAttributed++;
          }
          continue;
        }

        const probe: ProbeResult = await this.registryCrawler.probeUrl(rawUrl, 'GET');
        if (probe.result?.agentHash) {
          this.stats.urlsDiscovered++;
          await this.serviceEndpointRepo.upsert(
            probe.result.agentHash,
            rawUrl,
            402,
            probe.result.latencyMs,
            'nostr_31402',
          );
        } else {
          this.stats.urlsProbeFailed++;
        }
      } catch (err) {
        this.stats.urlsProbeFailed++;
        logger.warn(
          { url: rawUrl, error: err instanceof Error ? err.message : String(err) },
          'Kind31402Consumer: ingestion failed',
        );
      }
    }
  }

  private emptyStats(): Kind31402Stats {
    return {
      eventsReceived: 0,
      eventsIgnoredBadSignature: 0,
      eventsIgnoredCrawler: 0,
      eventsIgnoredNonLightning: 0,
      eventsIgnoredMalformed: 0,
      eventsTruncatedUrls: 0,
      urlsAttempted: 0,
      urlsMergedExisting: 0,
      urlsAlreadyAttributed: 0,
      urlsDiscovered: 0,
      urlsSkippedUnsafe: 0,
      urlsSkippedTemplated: 0,
      urlsProbeFailed: 0,
    };
  }
}
