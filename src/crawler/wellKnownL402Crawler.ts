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
import { isSafeUrl, fetchSafeExternal, readBodyCapped } from '../utils/ssrf';

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
/** Sim 8 follow-up audit H2 — hard cap on the manifest body size. Sats4AI's
 *  current manifest is ~10KB; 1 MB is 100× headroom and well below any
 *  reasonable interpretation of the /.well-known/l402 spec. */
const MANIFEST_MAX_BYTES = 1_048_576;
/** Sim 8 follow-up audit H3 — also limit the per-host endpoint count after
 *  parse so a hostile manifest can't iterate 50k entries even within the
 *  byte cap. */
const MAX_ENDPOINTS_PER_MANIFEST = 500;

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
  // Audit M4 — defense-in-depth: WELLKNOWN_L402_HOSTS could otherwise be
  // misconfigured to include a private-IP host, which would let the manifest
  // fetch land on internal infra. isSafeUrl rejects loopback/RFC1918/CGN.
  return raw
    .split(',')
    .map(s => s.trim().replace(/\/$/, ''))
    .filter(s => s.length > 0 && /^https:\/\//.test(s) && isSafeUrl(s + '/.well-known/l402'));
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
        // Audit H1+M3 — fetchSafeExternal closes the SSRF redirect path
        // (default redirect: 'manual') and validates the resolved IP at
        // connect time inside the undici Agent dispatcher. Plain fetch()
        // would auto-follow 3xx into private IPs and skip DNS-rebinding
        // protection (TOCTOU between isSafeUrl and connect).
        const resp = await fetchSafeExternal(manifestUrl, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { 'User-Agent': 'SatRank-WellKnownL402Crawler/1.0' },
        });
        if (!resp.ok) {
          result.preCapSkipped.no_response++;
          result.errors++;
          result.perHost.push(perHostStat);
          continue;
        }
        // Audit H2 — hard byte cap before JSON parse so a hostile manifest
        // can't OOM the crawler.
        const { body, truncated } = await readBodyCapped(resp, MANIFEST_MAX_BYTES);
        if (truncated) {
          logger.warn({ manifestUrl, maxBytes: MANIFEST_MAX_BYTES }, 'WellKnownL402: manifest truncated at byte cap');
          result.preCapSkipped.malformed_manifest++;
          result.perHost.push(perHostStat);
          continue;
        }
        manifest = JSON.parse(body.toString('utf8')) as WellKnownManifest;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ manifestUrl, error: msg }, 'WellKnownL402: manifest fetch failed');
        result.preCapSkipped.no_response++;
        result.errors++;
        result.perHost.push(perHostStat);
        continue;
      }

      // Audit H3 — pin providerUrl to the host we just fetched. A compromised
      // manifest could otherwise set provider.url to attacker-controlled and
      // cause us to probe an arbitrary domain (turning SatRank into a probe
      // amplifier against a third party).
      const declaredProvider = manifest.provider?.url ?? host;
      const providerUrl =
        hostnameOf(declaredProvider) === hostnameOf(host)
          ? declaredProvider
          : host;
      if (providerUrl !== declaredProvider) {
        logger.warn(
          { manifestUrl, declaredProvider, manifestHost: hostnameOf(host) },
          'WellKnownL402: provider.url host does not match manifest host — pinned to manifest host',
        );
      }
      const rawEndpoints = Array.isArray(manifest.endpoints) ? manifest.endpoints : [];
      // Audit H2 — also bound endpoint count so even a small valid-JSON
      // manifest can't drive an unbounded loop.
      const endpoints = rawEndpoints.slice(0, MAX_ENDPOINTS_PER_MANIFEST);
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
