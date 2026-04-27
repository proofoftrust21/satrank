// Vague 3 Phase 3 — L402DirectoryCrawler.
//
// Curated secondary catalogue at https://l402.directory. Smaller than
// 402index (8 services / 42 endpoints observed 2026-04-27) but verified
// via .well-known/l402-directory-verify.txt and exposes signals 402index
// doesn't (consumption.type, provider.contact, lnget_compatible).
//
// Strategy: cross-source dedup via service_endpoints.sources[]. When a URL
// is already in the DB (almost always via 402index), we attach the
// 'l402directory' attribution without re-probing or incrementing health
// counters. New URLs go through the full RegistryCrawler.probeUrl path so
// the BOLT11 → agent_hash mapping works identically across sources.
//
// Output: Identical funnel breakdown to RegistryCrawler.run() so the
// /api/health observer can compare both sources without special-casing.
import { logger } from '../logger';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { RegistryCrawler, ProbeResult } from './registryCrawler';
import { isSafeUrl } from '../utils/ssrf';

/** Subset of l402.directory's service object we actually care about.
 *  The full schema is richer (categories, payment_methods, expires_at, etc.)
 *  but Phase 3 sticks to the fields that drive ingestion or fill new columns. */
interface L402DirectoryEndpoint {
  url: string;
  method?: string;
  description?: string;
  pricing?: { amount?: number; currency?: string; model?: string };
  consumption?: { type?: string };
}

interface L402DirectoryService {
  service_id: string;
  name: string;
  description?: string;
  status: string;
  destination_pubkey?: string | null;
  endpoints: L402DirectoryEndpoint[];
  provider?: { name?: string; contact?: string; url?: string };
  categories?: string[];
}

interface L402DirectoryResponse {
  count: number;
  services: L402DirectoryService[];
}

const FEED_URL = 'https://l402.directory/api/services?status=all';
const FETCH_TIMEOUT_MS = 5000;

const HOST_INGESTION_CAP_PER_CYCLE = parseInt(
  process.env.L402DIR_HOST_INGESTION_CAP_PER_CYCLE
    ?? process.env.HOST_INGESTION_CAP_PER_CYCLE
    ?? '50',
  10,
);
const ABSOLUTE_HOST_CAP_TOTAL = parseInt(
  process.env.L402DIR_ABSOLUTE_HOST_CAP_TOTAL
    ?? process.env.ABSOLUTE_HOST_CAP_TOTAL
    ?? '100',
  10,
);

/** Pre-cap funnel buckets — same structure as RegistryCrawler's PreCapSkipped
 *  plus `templated_url` (l402.directory exposes URL templates with
 *  `{pubkey}` etc., which can't be probed without substitution and so are
 *  honestly accounted as a distinct bucket rather than polluting `not_402`). */
export interface L402DirectoryPreCapSkipped {
  not_paid: number;
  service_offline: number;
  templated_url: number;
  unsafe_url: number;
  no_response: number;
  method_405_both: number;
  not_acceptable_406: number;
  not_402: number;
  fossil_404: number;
  invalid_l402: number;
  other: number;
}

export interface L402DirectoryCrawlResult {
  totalServices: number;
  totalEndpointsRaw: number;
  candidates: number;
  /** Endpoints whose URL was already in service_endpoints — attribution merged
   *  via attachSource without a fresh probe. */
  mergedExisting: number;
  /** Endpoints whose URL was already in service_endpoints AND already had the
   *  'l402directory' attribution — no-op idempotent revisit. */
  alreadyAttributed: number;
  /** Net-new endpoints discovered + ingested via probeUrl this cycle. */
  discovered: number;
  /** Per-cycle cap hits (skipped this cycle, reconsidered next cycle). */
  capped: number;
  /** Absolute cap hits (skipped permanently until host count drops). */
  absoluteCapped: number;
  errors: number;
  preCapSkipped: L402DirectoryPreCapSkipped;
  cappedHosts: Array<{ host: string; ingested: number }>;
  absoluteCappedHosts: string[];
}

/** Vague 3 Phase 3 — extract a hostname for the per-host caps. Mirrors
 *  registryCrawler.hostnameOf to keep the cap semantics identical. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Vague 3 Phase 3 — l402.directory exposes URL templates like
 *  `https://l402.services/ln/node/{pubkey}/channels`. These can't be probed
 *  without substitution (the server returns 4xx on the literal `{pubkey}`).
 *  We track them in a dedicated bucket rather than burying them under `not_402`. */
function isTemplatedUrl(url: string): boolean {
  return /\{[^}]+\}/.test(url);
}

function normaliseMethod(raw: string | undefined): 'GET' | 'POST' {
  return (raw ?? '').toUpperCase() === 'POST' ? 'POST' : 'GET';
}

export class L402DirectoryCrawler {
  private readonly hostIngestionCapPerCycle: number;
  private readonly absoluteHostCapTotal: number;

  constructor(
    private serviceEndpointRepo: ServiceEndpointRepository,
    private registryCrawler: Pick<RegistryCrawler, 'probeUrl'>,
    hostIngestionCapPerCycle: number = HOST_INGESTION_CAP_PER_CYCLE,
    absoluteHostCapTotal: number = ABSOLUTE_HOST_CAP_TOTAL,
  ) {
    this.hostIngestionCapPerCycle = hostIngestionCapPerCycle;
    this.absoluteHostCapTotal = absoluteHostCapTotal;
  }

  async run(): Promise<L402DirectoryCrawlResult> {
    const result: L402DirectoryCrawlResult = {
      totalServices: 0,
      totalEndpointsRaw: 0,
      candidates: 0,
      mergedExisting: 0,
      alreadyAttributed: 0,
      discovered: 0,
      capped: 0,
      absoluteCapped: 0,
      errors: 0,
      preCapSkipped: {
        not_paid: 0,
        service_offline: 0,
        templated_url: 0,
        unsafe_url: 0,
        no_response: 0,
        method_405_both: 0,
        not_acceptable_406: 0,
        not_402: 0,
        fossil_404: 0,
        invalid_l402: 0,
        other: 0,
      },
      cappedHosts: [],
      absoluteCappedHosts: [],
    };

    let payload: L402DirectoryResponse;
    try {
      const resp = await fetch(FEED_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'SatRank-L402DirectoryCrawler/1.0' },
      });
      if (!resp.ok) throw new Error(`l402.directory returned ${resp.status}`);
      payload = (await resp.json()) as L402DirectoryResponse;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ feed: FEED_URL, error: msg }, 'L402Directory feed fetch failed');
      result.errors++;
      return result;
    }

    result.totalServices = payload.services?.length ?? 0;

    // Pre-fetch existing host counts so we apply the absolute cap against the
    // current catalogue state, not against this cycle's ingestion budget alone.
    const existingByHost = await this.serviceEndpointRepo.countActiveByHost();
    const newIngestionsByHost = new Map<string, number>();
    const absoluteCappedHosts = new Set<string>();

    for (const service of payload.services ?? []) {
      const isOffline = service.status !== 'live';
      for (const ep of service.endpoints ?? []) {
        result.totalEndpointsRaw++;

        // Only paid + live endpoints are L402-gated. Free helpers and offline
        // services aren't catalogue candidates.
        const amount = ep.pricing?.amount ?? 0;
        if (amount <= 0) {
          result.preCapSkipped.not_paid++;
          continue;
        }
        if (isOffline) {
          result.preCapSkipped.service_offline++;
          continue;
        }
        if (isTemplatedUrl(ep.url)) {
          result.preCapSkipped.templated_url++;
          continue;
        }
        if (!isSafeUrl(ep.url)) {
          result.preCapSkipped.unsafe_url++;
          continue;
        }

        result.candidates++;

        // Cross-source dedup: if URL is already in DB, just attach the source
        // attribution without re-probing. Note: deprecated rows are kept on
        // file (consecutive_404_count etc.) and l402.directory listing them is
        // a useful signal to maybe lift the deprecation, but we don't auto-lift
        // here — rely on the existing clear404Streak flow at probe time.
        const existing = await this.serviceEndpointRepo.findByUrl(ep.url);
        if (existing) {
          const attached = await this.serviceEndpointRepo.attachSource(
            ep.url,
            'l402directory',
            {
              consumption_type: ep.consumption?.type ?? null,
              provider_contact: service.provider?.contact ?? null,
            },
          );
          if (!attached.found) {
            // Race: row deleted between findByUrl and UPDATE — treat as miss.
            result.preCapSkipped.other++;
          } else if (attached.added) {
            result.mergedExisting++;
          } else {
            result.alreadyAttributed++;
          }
          continue;
        }

        // Net-new candidate. Apply caps before probing to avoid burning the
        // per-host rate limiter on hosts that are already saturated.
        const host = hostnameOf(ep.url);
        const lifetimeCount = existingByHost.get(host) ?? 0;
        if (lifetimeCount >= this.absoluteHostCapTotal) {
          result.absoluteCapped++;
          absoluteCappedHosts.add(host);
          continue;
        }
        const usedThisCycle = newIngestionsByHost.get(host) ?? 0;
        if (usedThisCycle >= this.hostIngestionCapPerCycle) {
          result.capped++;
          continue;
        }

        try {
          const method = normaliseMethod(ep.method);
          const probe: ProbeResult = await this.registryCrawler.probeUrl(ep.url, method);
          if (probe.result?.agentHash) {
            result.discovered++;
            newIngestionsByHost.set(host, usedThisCycle + 1);
            existingByHost.set(host, lifetimeCount + 1);
            await this.serviceEndpointRepo.upsert(
              probe.result.agentHash,
              ep.url,
              402,
              probe.result.latencyMs,
              'l402directory',
            );
            // Attach metadata available only via l402.directory. attachSource
            // is null-safe via COALESCE so it never overwrites richer 402index
            // data on already-known rows.
            await this.serviceEndpointRepo.attachSource(ep.url, 'l402directory', {
              consumption_type: ep.consumption?.type ?? null,
              provider_contact: service.provider?.contact ?? null,
            });
          } else {
            // Bucket the silent miss into the funnel using the outcome from
            // the registry crawler's discovery primitive — same reasons that
            // matter for 402index also matter here.
            const reason = probe.outcome?.reason;
            switch (reason) {
              case 'method_405_both': result.preCapSkipped.method_405_both++; break;
              case 'not_acceptable_406': result.preCapSkipped.not_acceptable_406++; break;
              case 'fossil_404': result.preCapSkipped.fossil_404++; break;
              case 'not_402': result.preCapSkipped.not_402++; break;
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
              { url: ep.url, error: err instanceof Error ? err.message : String(err) },
              'L402Directory: failed to probe URL',
            );
          }
        }
      }
    }

    result.cappedHosts = Array.from(newIngestionsByHost.entries())
      .filter(([, c]) => c >= this.hostIngestionCapPerCycle)
      .map(([h, c]) => ({ host: h, ingested: c }));
    result.absoluteCappedHosts = Array.from(absoluteCappedHosts);

    logger.info(
      {
        ...result,
        hostCapPerCycle: this.hostIngestionCapPerCycle,
        absoluteHostCapTotal: this.absoluteHostCapTotal,
      },
      'L402Directory crawl complete',
    );
    return result;
  }
}
