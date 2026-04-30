// Sim 8 follow-up (2026-04-30) — AwesomeL402Crawler.
//
// Scrapes the Fewsats/awesome-L402 README for HTTPS URLs and feeds plausible
// L402 endpoints through RegistryCrawler.probeUrl. The yield is small (the
// list is mostly docs / repos / specs) but the audit found ~5 services worth
// trying. The probe primitive's funnel handles the docs/blog noise — anything
// that doesn't return 402 with a BOLT11 invoice falls into not_402 / not_paid.
//
// Blocklist: GitHub repos, doc sites, video-only links, known-broken services
// (satring 500, chat.bitcoinsearch dormant per 2026-04-30 audit).
import { logger } from '../logger';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { RegistryCrawler, ProbeResult } from './registryCrawler';
import { isSafeUrl } from '../utils/ssrf';

const README_URL =
  'https://raw.githubusercontent.com/Fewsats/awesome-L402/main/README.md';
const FETCH_TIMEOUT_MS = 8000;

const HOST_INGESTION_CAP_PER_CYCLE = parseInt(
  process.env.AWESOME_L402_HOST_INGESTION_CAP_PER_CYCLE
    ?? process.env.HOST_INGESTION_CAP_PER_CYCLE
    ?? '50',
  10,
);
const ABSOLUTE_HOST_CAP_TOTAL = parseInt(
  process.env.AWESOME_L402_ABSOLUTE_HOST_CAP_TOTAL
    ?? process.env.ABSOLUTE_HOST_CAP_TOTAL
    ?? '100',
  10,
);

/** Hosts and prefixes never worth probing — pure docs / repos / videos /
 *  abandoned services. The probe's funnel would catch them all eventually
 *  but every miss costs an HTTP call against a real server. */
const BLOCKLIST_HOSTS = new Set([
  'github.com',
  'gitlab.com',
  'gist.github.com',
  'raw.githubusercontent.com',
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
  'twitter.com',
  'x.com',
  'medium.com',
  'mirror.xyz',
  'reddit.com',
  'www.reddit.com',
  'news.ycombinator.com',
  'stacker.news',
  'colab.research.google.com',
  'research.google',
  'fly.io',
  'lightning.engineering',
  'docs.lightning.engineering',
  // Already covered or known-broken per 2026-04-30 audit
  'satring.com',
  'chat.bitcoinsearch.xyz',
  'l402.directory',
  '402index.io',
  'www.402index.io',
  'satrank.dev',
  'www.satrank.dev',
  'l402.org',
  'lsat-playground.bucko.vercel.app',
]);

/** URL prefixes to skip even when host isn't fully blocklisted. */
const BLOCKLIST_PREFIXES = [
  'https://docs.',
  'https://help.',
  'https://blog.',
  'https://www.businesswire.com',
  'https://l402.org/',
];

export interface AwesomeL402PreCapSkipped {
  no_response: number;
  malformed_readme: number;
  blocklisted: number;
  unsafe_url: number;
  templated_url: number;
  method_405_both: number;
  not_acceptable_406: number;
  not_402: number;
  fossil_404: number;
  invalid_l402: number;
  protocol_x402: number;
  other: number;
}

export interface AwesomeL402CrawlResult {
  totalUrlsFound: number;
  candidates: number;
  mergedExisting: number;
  alreadyAttributed: number;
  discovered: number;
  capped: number;
  absoluteCapped: number;
  errors: number;
  preCapSkipped: AwesomeL402PreCapSkipped;
}

/** Extract HTTPS URLs from a markdown blob. Pulls from `[text](url)` and
 *  bare https:// occurrences. Output is deduplicated. */
export function extractHttpsUrls(markdown: string): string[] {
  const urls = new Set<string>();
  const linkRegex = /\[[^\]]*\]\((https:\/\/[^)\s]+)\)/g;
  const bareRegex = /(?<![\w(])(https:\/\/[^\s)<>"']+)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(markdown)) !== null) {
    urls.add(m[1].replace(/[.,)]+$/, ''));
  }
  while ((m = bareRegex.exec(markdown)) !== null) {
    urls.add(m[1].replace(/[.,)]+$/, ''));
  }
  return Array.from(urls);
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

function isBlocklisted(url: string): boolean {
  const host = hostnameOf(url);
  if (BLOCKLIST_HOSTS.has(host)) return true;
  for (const prefix of BLOCKLIST_PREFIXES) {
    if (url.startsWith(prefix)) return true;
  }
  return false;
}

function isTemplatedUrl(url: string): boolean {
  return /\{[^}]+\}/.test(url);
}

export class AwesomeL402Crawler {
  private readonly hostIngestionCapPerCycle: number;
  private readonly absoluteHostCapTotal: number;

  constructor(
    private serviceEndpointRepo: ServiceEndpointRepository,
    private registryCrawler: Pick<RegistryCrawler, 'probeUrl'>,
    private readmeUrl: string = README_URL,
    hostIngestionCapPerCycle: number = HOST_INGESTION_CAP_PER_CYCLE,
    absoluteHostCapTotal: number = ABSOLUTE_HOST_CAP_TOTAL,
  ) {
    this.hostIngestionCapPerCycle = hostIngestionCapPerCycle;
    this.absoluteHostCapTotal = absoluteHostCapTotal;
  }

  async run(): Promise<AwesomeL402CrawlResult> {
    const result: AwesomeL402CrawlResult = {
      totalUrlsFound: 0,
      candidates: 0,
      mergedExisting: 0,
      alreadyAttributed: 0,
      discovered: 0,
      capped: 0,
      absoluteCapped: 0,
      errors: 0,
      preCapSkipped: {
        no_response: 0,
        malformed_readme: 0,
        blocklisted: 0,
        unsafe_url: 0,
        templated_url: 0,
        method_405_both: 0,
        not_acceptable_406: 0,
        not_402: 0,
        fossil_404: 0,
        invalid_l402: 0,
        protocol_x402: 0,
        other: 0,
      },
    };

    let markdown: string;
    try {
      const resp = await fetch(this.readmeUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'SatRank-AwesomeL402Crawler/1.0' },
      });
      if (!resp.ok) throw new Error(`README returned ${resp.status}`);
      markdown = await resp.text();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ readmeUrl: this.readmeUrl, error: msg }, 'AwesomeL402 README fetch failed');
      result.errors++;
      result.preCapSkipped.no_response++;
      return result;
    }

    if (markdown.length < 100) {
      result.preCapSkipped.malformed_readme++;
      return result;
    }

    const urls = extractHttpsUrls(markdown);
    result.totalUrlsFound = urls.length;

    const existingByHost = await this.serviceEndpointRepo.countActiveByHost();
    const newIngestionsByHost = new Map<string, number>();

    for (const url of urls) {
      if (isBlocklisted(url)) {
        result.preCapSkipped.blocklisted++;
        continue;
      }
      if (isTemplatedUrl(url)) {
        result.preCapSkipped.templated_url++;
        continue;
      }
      if (!isSafeUrl(url)) {
        result.preCapSkipped.unsafe_url++;
        continue;
      }

      result.candidates++;

      const existing = await this.serviceEndpointRepo.findByUrl(url);
      if (existing) {
        const attached = await this.serviceEndpointRepo.attachSource(url, 'awesome_l402');
        if (!attached.found) {
          result.preCapSkipped.other++;
        } else if (attached.added) {
          result.mergedExisting++;
        } else {
          result.alreadyAttributed++;
        }
        continue;
      }

      const host = hostnameOf(url);
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
        const probe: ProbeResult = await this.registryCrawler.probeUrl(url, 'GET');
        if (probe.result?.agentHash) {
          result.discovered++;
          newIngestionsByHost.set(host, usedThisCycle + 1);
          existingByHost.set(host, lifetimeCount + 1);
          await this.serviceEndpointRepo.upsert(
            probe.result.agentHash,
            url,
            402,
            probe.result.latencyMs,
            'awesome_l402',
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
            { url, error: err instanceof Error ? err.message : String(err) },
            'AwesomeL402: failed to probe URL',
          );
        }
      }
    }

    logger.info(
      {
        ...result,
        readmeUrl: this.readmeUrl,
        hostCapPerCycle: this.hostIngestionCapPerCycle,
        absoluteHostCapTotal: this.absoluteHostCapTotal,
      },
      'AwesomeL402 crawl complete',
    );
    return result;
  }
}
