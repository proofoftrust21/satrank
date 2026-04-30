// Sim 8 follow-up (2026-04-30) — L402IndexRssCrawler.
//
// Change-stream over 402index.io's /feed.xml. Same upstream truth as the
// main RegistryCrawler but lighter cadence — surfaces new listings in the
// 100-item rolling window without re-scanning the full index.
//
// Filtering: SatRank is Lightning-pure (decision 2026-04-30). Items whose
// `<l402:protocol type="...">` is `x402` are dropped at parse time. Only
// `type="L402"` reaches the probe primitive.
//
// XML parsing: regex-based. The feed is small (100 items max), the schema
// is fixed and namespaced, and adding xml2js/fast-xml-parser to the deps
// for one consumer is heavier than the parsing logic itself.
import { logger } from '../logger';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { RegistryCrawler, ProbeResult } from './registryCrawler';
import { isSafeUrl, fetchSafeExternal, readBodyCapped } from '../utils/ssrf';

const FEED_URL = 'https://402index.io/feed.xml';
const FETCH_TIMEOUT_MS = 8000;
/** Audit H2 — hard byte cap on the RSS feed. Today's feed is ~25KB; 512KB
 *  is 20× headroom. Any compliant 100-item rolling window fits trivially. */
const FEED_MAX_BYTES = 524_288;
/** Audit H2 — also cap the parsed item count after parse so a hostile
 *  feed can't drive an unbounded loop within the byte cap. */
const MAX_ITEMS_PARSED = 500;

const HOST_INGESTION_CAP_PER_CYCLE = parseInt(
  process.env.L402INDEX_RSS_HOST_INGESTION_CAP_PER_CYCLE
    ?? process.env.HOST_INGESTION_CAP_PER_CYCLE
    ?? '50',
  10,
);
const ABSOLUTE_HOST_CAP_TOTAL = parseInt(
  process.env.L402INDEX_RSS_ABSOLUTE_HOST_CAP_TOTAL
    ?? process.env.ABSOLUTE_HOST_CAP_TOTAL
    ?? '100',
  10,
);

interface RssItem {
  url: string;
  method: 'GET' | 'POST';
  protocol: 'L402' | 'x402' | 'unknown';
}

export interface L402IndexRssPreCapSkipped {
  no_response: number;
  malformed_xml: number;
  protocol_x402: number;
  unsafe_url: number;
  templated_url: number;
  method_405_both: number;
  not_acceptable_406: number;
  not_402: number;
  fossil_404: number;
  invalid_l402: number;
  other: number;
}

export interface L402IndexRssCrawlResult {
  totalItemsRaw: number;
  candidates: number;
  mergedExisting: number;
  alreadyAttributed: number;
  discovered: number;
  capped: number;
  absoluteCapped: number;
  errors: number;
  preCapSkipped: L402IndexRssPreCapSkipped;
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

function isTemplatedUrl(url: string): boolean {
  return /\{[^}]+\}/.test(url);
}

/** Parse the 402index RSS payload into Lightning-only items. Returns the raw
 *  count separately so the caller can log how many x402 items we filtered.
 *  Audit H2 — caps the parsed item count at MAX_ITEMS_PARSED to bound CPU
 *  even when the input passes the byte cap. */
export function parseFeed(xml: string): { items: RssItem[]; rawCount: number; x402Filtered: number } {
  const items: RssItem[] = [];
  let x402Filtered = 0;
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  const endpointRegex = /<l402:endpoint\s+url="([^"]+)"(?:\s+method="([^"]*)")?\s*\/>/;
  const protocolRegex = /<l402:protocol\s+type="([^"]+)"/;
  let m: RegExpExecArray | null;
  let raw = 0;
  while ((m = itemRegex.exec(xml)) !== null) {
    if (raw >= MAX_ITEMS_PARSED) break;
    raw++;
    const inner = m[1];
    const ep = endpointRegex.exec(inner);
    if (!ep) continue;
    const proto = protocolRegex.exec(inner);
    const protocol: RssItem['protocol'] =
      proto?.[1] === 'L402' ? 'L402' :
      proto?.[1] === 'x402' ? 'x402' : 'unknown';
    if (protocol === 'x402') {
      x402Filtered++;
      continue;
    }
    const method: 'GET' | 'POST' = (ep[2] ?? '').toUpperCase() === 'POST' ? 'POST' : 'GET';
    items.push({ url: ep[1], method, protocol });
  }
  return { items, rawCount: raw, x402Filtered };
}

export class L402IndexRssCrawler {
  private readonly hostIngestionCapPerCycle: number;
  private readonly absoluteHostCapTotal: number;

  constructor(
    private serviceEndpointRepo: ServiceEndpointRepository,
    private registryCrawler: Pick<RegistryCrawler, 'probeUrl'>,
    private feedUrl: string = FEED_URL,
    hostIngestionCapPerCycle: number = HOST_INGESTION_CAP_PER_CYCLE,
    absoluteHostCapTotal: number = ABSOLUTE_HOST_CAP_TOTAL,
  ) {
    this.hostIngestionCapPerCycle = hostIngestionCapPerCycle;
    this.absoluteHostCapTotal = absoluteHostCapTotal;
  }

  async run(): Promise<L402IndexRssCrawlResult> {
    const result: L402IndexRssCrawlResult = {
      totalItemsRaw: 0,
      candidates: 0,
      mergedExisting: 0,
      alreadyAttributed: 0,
      discovered: 0,
      capped: 0,
      absoluteCapped: 0,
      errors: 0,
      preCapSkipped: {
        no_response: 0,
        malformed_xml: 0,
        protocol_x402: 0,
        unsafe_url: 0,
        templated_url: 0,
        method_405_both: 0,
        not_acceptable_406: 0,
        not_402: 0,
        fossil_404: 0,
        invalid_l402: 0,
        other: 0,
      },
    };

    let xml: string;
    try {
      // Audit H1+M3 — fetchSafeExternal closes the redirect-to-private-IP
      // path and validates the resolved IP at connect time (DNS rebinding
      // protection that plain fetch lacks).
      const resp = await fetchSafeExternal(this.feedUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'SatRank-L402IndexRssCrawler/1.0' },
      });
      if (!resp.ok) throw new Error(`feed returned ${resp.status}`);
      // Audit H2 — hard byte cap before regex parse to prevent OOM via a
      // multi-hundred-MB hostile feed.
      const { body, truncated } = await readBodyCapped(resp, FEED_MAX_BYTES);
      if (truncated) {
        logger.warn({ feed: this.feedUrl, maxBytes: FEED_MAX_BYTES }, 'L402IndexRss: feed truncated at byte cap');
      }
      xml = body.toString('utf8');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ feed: this.feedUrl, error: msg }, 'L402IndexRss feed fetch failed');
      result.errors++;
      result.preCapSkipped.no_response++;
      return result;
    }

    let items: RssItem[];
    let x402Filtered: number;
    try {
      const parsed = parseFeed(xml);
      result.totalItemsRaw = parsed.rawCount;
      items = parsed.items;
      x402Filtered = parsed.x402Filtered;
      result.preCapSkipped.protocol_x402 += x402Filtered;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ feed: this.feedUrl, error: msg }, 'L402IndexRss feed parse failed');
      result.errors++;
      result.preCapSkipped.malformed_xml++;
      return result;
    }

    const existingByHost = await this.serviceEndpointRepo.countActiveByHost();
    const newIngestionsByHost = new Map<string, number>();

    for (const item of items) {
      if (isTemplatedUrl(item.url)) {
        result.preCapSkipped.templated_url++;
        continue;
      }
      if (!isSafeUrl(item.url)) {
        result.preCapSkipped.unsafe_url++;
        continue;
      }

      result.candidates++;

      const existing = await this.serviceEndpointRepo.findByUrl(item.url);
      if (existing) {
        const attached = await this.serviceEndpointRepo.attachSource(item.url, 'l402index_rss');
        if (!attached.found) {
          result.preCapSkipped.other++;
        } else if (attached.added) {
          result.mergedExisting++;
        } else {
          result.alreadyAttributed++;
        }
        continue;
      }

      const host = hostnameOf(item.url);
      const lifetimeCount = existingByHost.get(host) ?? 0;
      if (lifetimeCount >= this.absoluteHostCapTotal) {
        result.absoluteCapped++;
        continue;
      }
      const usedThisCycle = newIngestionsByHost.get(host) ?? 0;
      if (usedThisCycle >= this.hostIngestionCapPerCycle) {
        result.capped++;
        continue;
      }

      try {
        const probe: ProbeResult = await this.registryCrawler.probeUrl(item.url, item.method);
        if (probe.result?.agentHash) {
          result.discovered++;
          newIngestionsByHost.set(host, usedThisCycle + 1);
          existingByHost.set(host, lifetimeCount + 1);
          await this.serviceEndpointRepo.upsert(
            probe.result.agentHash,
            item.url,
            402,
            probe.result.latencyMs,
            'l402index_rss',
          );
        } else {
          const reason = probe.outcome?.reason;
          switch (reason) {
            case 'method_405_both': result.preCapSkipped.method_405_both++; break;
            case 'not_acceptable_406': result.preCapSkipped.not_acceptable_406++; break;
            case 'fossil_404': result.preCapSkipped.fossil_404++; break;
            case 'not_402': result.preCapSkipped.not_402++; break;
            case 'protocol_x402': result.preCapSkipped.protocol_x402++; break;
            case 'invalid_l402_no_bolt11':
            case 'decode_failed':
            case 'invoice_malformed':
            case 'no_decoder':
              result.preCapSkipped.invalid_l402++; break;
            case 'ssrf_blocked':
            case 'network_error':
              result.preCapSkipped.no_response++; break;
            default: result.preCapSkipped.other++; break;
          }
        }
      } catch (err: unknown) {
        result.errors++;
        if (result.errors <= 10) {
          logger.warn(
            { url: item.url, error: err instanceof Error ? err.message : String(err) },
            'L402IndexRss: failed to probe URL',
          );
        }
      }
    }

    logger.info(
      {
        ...result,
        feed: this.feedUrl,
        x402Filtered,
        hostCapPerCycle: this.hostIngestionCapPerCycle,
        absoluteHostCapTotal: this.absoluteHostCapTotal,
      },
      'L402IndexRss crawl complete',
    );
    return result;
  }
}
