// Sim 8 follow-up (2026-04-30) — WellKnownL402Crawler.
//
// Generic crawler for operators that publish a /.well-known/l402 manifest
// (the convention pioneered by Sats4AI). The manifest is a single JSON blob
// listing every L402 endpoint the operator hosts, with method/category/price
// per entry. First wired host: sats4ai.com (32 AI tooling endpoints —
// highest single-source net-new yield discovered in the 2026-04-30 catalogue
// audit). Adding a new host = single env var change.
//
// Strategy: fetch the manifest, build full URLs (provider.url + endpoint.path),
// then run each through RegistryCrawler.probeUrl so the BOLT11 → agent_hash
// mapping and the Tier 1B/C/4M filters apply identically to every source.
//
// Cross-source dedup: if the URL already exists, attachSource('wellknown_l402')
// merges the attribution without re-probing. Net-new URLs go through the
// full discovery primitive.
import { logger } from '../logger';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { RegistryCrawler, ProbeResult } from './registryCrawler';
import { isSafeUrl } from '../utils/ssrf';

/** A single endpoint inside a /.well-known/l402 manifest. Extra fields beyond
 *  these are accepted but ignored — we only need what feeds discovery. */
interface WellKnownEndpoint {
  path: string;
  method?: string;
  category?: string;
  description?: string;
  price_sats?: string | number;
}

interface WellKnownManifest {
  protocol?: string;
  provider?: { name?: string; url?: string; description?: string };
  endpoints?: WellKnownEndpoint[];
}

const FETCH_TIMEOUT_MS = 5000;

/** Default seed list. Each entry is the operator's HTTPS root; we append
 *  `/.well-known/l402` to fetch the manifest. Override via the
 *  WELLKNOWN_L402_HOSTS env var (comma-separated) when adding new operators. */
const DEFAULT_HOSTS = [
  'https://sats4ai.com',
];

const HOST_INGESTION_CAP_PER_CYCLE = parseInt(
  process.env.WELLKNOWN_HOST_INGESTION_CAP_PER_CYCLE
    ?? process.env.HOST_INGESTION_CAP_PER_CYCLE
    ?? '50',
  10,
);
const ABSOLUTE_HOST_CAP_TOTAL = parseInt(
  process.env.WELLKNOWN_ABSOLUTE_HOST_CAP_TOTAL
    ?? process.env.ABSOLUTE_HOST_CAP_TOTAL
    ?? '100',
  10,
);

export interface WellKnownL402PreCapSkipped {
  no_response: number;
  malformed_manifest: number;
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

export interface WellKnownL402CrawlResult {
  hostsAttempted: number;
  hostsManifestOk: number;
  totalEndpointsRaw: number;
  candidates: number;
  mergedExisting: number;
  alreadyAttributed: number;
  discovered: number;
  capped: number;
  absoluteCapped: number;
  errors: number;
  preCapSkipped: WellKnownL402PreCapSkipped;
  perHost: Array<{ host: string; manifestOk: boolean; discovered: number; mergedExisting: number }>;
}

function parseHosts(): string[] {
  const raw = process.env.WELLKNOWN_L402_HOSTS;
  if (!raw) return DEFAULT_HOSTS;
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0 && /^https:\/\//.test(s));
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

function isTemplatedUrl(url: string): boolean {
  return /\{[^}]+\}/.test(url);
}

function normaliseMethod(raw: string | undefined): 'GET' | 'POST' {
  return (raw ?? '').toUpperCase() === 'POST' ? 'POST' : 'GET';
}

function joinUrl(host: string, path: string): string | null {
  try {
    return new URL(path, host).toString();
  } catch {
    return null;
  }
}

export class WellKnownL402Crawler {
  private readonly hosts: string[];
  private readonly hostIngestionCapPerCycle: number;
  private readonly absoluteHostCapTotal: number;

  constructor(
    private serviceEndpointRepo: ServiceEndpointRepository,
    private registryCrawler: Pick<RegistryCrawler, 'probeUrl'>,
    hosts: string[] = parseHosts(),
    hostIngestionCapPerCycle: number = HOST_INGESTION_CAP_PER_CYCLE,
    absoluteHostCapTotal: number = ABSOLUTE_HOST_CAP_TOTAL,
  ) {
    this.hosts = hosts;
    this.hostIngestionCapPerCycle = hostIngestionCapPerCycle;
    this.absoluteHostCapTotal = absoluteHostCapTotal;
  }

  async run(): Promise<WellKnownL402CrawlResult> {
    const result: WellKnownL402CrawlResult = {
      hostsAttempted: 0,
      hostsManifestOk: 0,
      totalEndpointsRaw: 0,
      candidates: 0,
      mergedExisting: 0,
      alreadyAttributed: 0,
      discovered: 0,
      capped: 0,
      absoluteCapped: 0,
      errors: 0,
      preCapSkipped: {
        no_response: 0,
        malformed_manifest: 0,
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
      perHost: [],
    };

    const existingByHost = await this.serviceEndpointRepo.countActiveByHost();
    const newIngestionsByHost = new Map<string, number>();

    for (const host of this.hosts) {
      result.hostsAttempted++;
      const manifestUrl = host.replace(/\/$/, '') + '/.well-known/l402';
      const perHostStat = { host, manifestOk: false, discovered: 0, mergedExisting: 0 };

      let manifest: WellKnownManifest;
      try {
        const resp = await fetch(manifestUrl, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { 'User-Agent': 'SatRank-WellKnownL402Crawler/1.0' },
        });
        if (!resp.ok) {
          result.preCapSkipped.no_response++;
          result.errors++;
          result.perHost.push(perHostStat);
          continue;
        }
        manifest = (await resp.json()) as WellKnownManifest;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ manifestUrl, error: msg }, 'WellKnownL402: manifest fetch failed');
        result.preCapSkipped.no_response++;
        result.errors++;
        result.perHost.push(perHostStat);
        continue;
      }

      const providerUrl = manifest.provider?.url ?? host;
      const endpoints = Array.isArray(manifest.endpoints) ? manifest.endpoints : [];
      if (endpoints.length === 0) {
        result.preCapSkipped.malformed_manifest++;
        result.perHost.push(perHostStat);
        continue;
      }

      result.hostsManifestOk++;
      perHostStat.manifestOk = true;

      for (const ep of endpoints) {
        result.totalEndpointsRaw++;

        if (typeof ep.path !== 'string' || ep.path.length === 0) {
          result.preCapSkipped.malformed_manifest++;
          continue;
        }
        // Check templating on the raw path: URL canonicalization percent-
        // encodes `{` and `}`, so checking the composed URL would always miss.
        if (isTemplatedUrl(ep.path)) {
          result.preCapSkipped.templated_url++;
          continue;
        }
        const fullUrl = joinUrl(providerUrl, ep.path);
        if (!fullUrl) {
          result.preCapSkipped.malformed_manifest++;
          continue;
        }
        if (!isSafeUrl(fullUrl)) {
          result.preCapSkipped.unsafe_url++;
          continue;
        }

        result.candidates++;

        const existing = await this.serviceEndpointRepo.findByUrl(fullUrl);
        if (existing) {
          const attached = await this.serviceEndpointRepo.attachSource(
            fullUrl,
            'wellknown_l402',
          );
          if (!attached.found) {
            result.preCapSkipped.other++;
          } else if (attached.added) {
            result.mergedExisting++;
            perHostStat.mergedExisting++;
          } else {
            result.alreadyAttributed++;
          }
          continue;
        }

        const epHost = hostnameOf(fullUrl);
        const lifetimeCount = existingByHost.get(epHost) ?? 0;
        if (lifetimeCount >= this.absoluteHostCapTotal) {
          result.absoluteCapped++;
          continue;
        }
        const usedThisCycle = newIngestionsByHost.get(epHost) ?? 0;
        if (usedThisCycle >= this.hostIngestionCapPerCycle) {
          result.capped++;
          continue;
        }

        try {
          const method = normaliseMethod(ep.method);
          const probe: ProbeResult = await this.registryCrawler.probeUrl(fullUrl, method);
          if (probe.result?.agentHash) {
            result.discovered++;
            perHostStat.discovered++;
            newIngestionsByHost.set(epHost, usedThisCycle + 1);
            existingByHost.set(epHost, lifetimeCount + 1);
            await this.serviceEndpointRepo.upsert(
              probe.result.agentHash,
              fullUrl,
              402,
              probe.result.latencyMs,
              'wellknown_l402',
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
              { url: fullUrl, error: err instanceof Error ? err.message : String(err) },
              'WellKnownL402: failed to probe URL',
            );
          }
        }
      }

      result.perHost.push(perHostStat);
    }

    logger.info(
      {
        ...result,
        hosts: this.hosts.length,
        hostCapPerCycle: this.hostIngestionCapPerCycle,
        absoluteHostCapTotal: this.absoluteHostCapTotal,
      },
      'WellKnownL402 crawl complete',
    );
    return result;
  }
}
