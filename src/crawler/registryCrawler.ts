// Registry crawler -- discovers L402 endpoints from 402index.io,
// extracts payee_node_key from BOLT11 invoices, maps URL -> LN node.
// Populates service_endpoints without paying any invoices.
//
// Phase 2 — voie 1 : quand un BOLT11 est extrait du WWW-Authenticate,
// on alimente preimage_pool (tier='medium', source='crawler') via
// insertIfAbsent. L'agent qui paiera plus tard un endpoint scrapé par
// 402index pourra alors reporter anonymement en fournissant sa preimage.
import { logger } from '../logger';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { PreimagePoolRepository } from '../repositories/preimagePoolRepository';
import { sha256 } from '../utils/crypto';
import { isSafeUrl, fetchSafeExternal, SsrfBlockedError } from '../utils/ssrf';
import { HostRateLimiter } from '../utils/hostRateLimiter';
import { ProviderHealthTracker } from '../utils/providerHealthTracker';
import { parseBolt11, InvalidBolt11Error } from '../utils/bolt11Parser';
import { validateCategoryOrNull } from '../utils/categoryValidation';

interface IndexService {
  url: string;
  protocol: string;
  name?: string;
  description?: string;
  category?: string;
  provider?: string;
  /** Vague 1 G.2 - upstream quality signals exposed by 402index. SatRank used
   *  to ignore them and re-derive everything from its own probes; we now copy
   *  them into service_endpoints.upstream_* and feed them into the bayesian
   *  prior cascade so newly ingested rows enter the catalogue with a
   *  meaningful prior instead of a flat Beta(1.5, 1.5). */
  health_status?: string;
  probe_status?: string;
  uptime_30d?: number;
  latency_p50_ms?: number;
  reliability_score?: number;
  last_checked?: string;
  registered_at?: string;
  price_sats?: number;
  /** Vague 3 phase 2 - HTTP method the endpoint expects. 402index exposes this
   *  per-entry (540 GET / 584 POST observed 2026-04-27). Drives our GET-first
   *  POST-fallback strategy in discoverNodeFromUrl: when 402index says POST,
   *  we POST directly; when it says GET (or omits the field), we GET and
   *  retry with POST on a 405 response. Without this, the entire 444-endpoint
   *  llm402.ai catalog is silently rejected because GET returns 405 there. */
  http_method?: string;
}

/** Vague 1 G.2 - parse a 402index ISO timestamp ("2026-04-26 18:13:16" or
 *  "2026-04-26T18:13:16Z") into epoch seconds. Returns null on parse failure
 *  so the caller can persist an explicit NULL rather than a NaN. */
function parseIso(ts: string | undefined): number | null {
  if (!ts) return null;
  // 402index returns a space-separated UTC timestamp, browsers expect the T.
  const normalised = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
  const ms = Date.parse(normalised);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** Vague 3 phase 2 - normalise the HTTP method advertised by the upstream
 *  registry. Defaults to 'GET' when missing or unrecognised; we still try POST
 *  as a fallback inside discoverNodeFromUrl, so an upstream that omits the
 *  field (e.g. a 2nd source added later that does not surface http_method)
 *  is not silently rejected. */
function normaliseHttpMethod(raw: string | undefined): 'GET' | 'POST' {
  return (raw ?? '').toUpperCase() === 'POST' ? 'POST' : 'GET';
}

/** Vague 3 phase 2 - extract a hostname for the per-host ingestion cap.
 *  Returns the empty string for malformed URLs, which puts them in a single
 *  bucket — they will share one cap budget rather than each consuming one. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Ingest silencieux côté crawler : valeurs invalides rejetées avec un warn
 *  log. Pas d'erreur levée — une page 402index polluée ne doit pas casser le
 *  crawl complet. Retourne null si la catégorie est absente OU invalide. */
function sanitizeCrawledCategory(raw: string | undefined, url: string): string | null {
  const validated = validateCategoryOrNull(raw);
  if (raw && !validated) {
    logger.warn({ rawCategory: raw, url }, 'registryCrawler: category rejected by regex validator');
  }
  return validated;
}

const PAGE_SIZE = 100;
// Minimum gap between calls to the SAME host. Historical global RATE_LIMIT_MS
// was applied to every iteration regardless of destination, which serialized
// unrelated hosts and still let dozens of same-host probes land inside a
// narrow window (2026-04-22 plebtv incident: 28 URLs of the same host hit
// plebtv's rate limit mid-backfill). HostRateLimiter keys cooldown on host
// so independent providers aren't penalized for each other's pace.
const PER_HOST_GAP_MS = 500;
const FETCH_TIMEOUT_MS = 5000;

/** Vague 3 phase 2 - cap on NEW ingestions per host per cycle. Vague 3 Phase
 *  2.6 makes both knobs env-overridable so an operator can speed up or slow
 *  down the ramp without redeploying. The defaults match the audit
 *  reasoning: 50/cycle smooths the llm402 ramp over ~9 days; 100 total
 *  prevents llm402 from ever exceeding 100 of the catalog regardless of
 *  cycle count, capping concentration permanently. */
const HOST_INGESTION_CAP_PER_CYCLE = parseInt(process.env.HOST_INGESTION_CAP_PER_CYCLE || '50', 10);
const ABSOLUTE_HOST_CAP_TOTAL = parseInt(process.env.ABSOLUTE_HOST_CAP_TOTAL || '100', 10);
/** Vague 3 Phase 2.6 - 404 streak length before flagging an endpoint
 *  deprecated. Three cycles default = at least one full cold tier rotation
 *  plus a buffer, so a transient route renaming on the provider does not
 *  immediately retire the row. Auto-reversible: a non-404 response resets
 *  the streak and clears the deprecated flag. */
const DEPRECATED_404_THRESHOLD = parseInt(process.env.DEPRECATED_404_THRESHOLD || '3', 10);

// Minimal BOLT11 payee extraction without external dependency.
// The payee pubkey is the last 264 bits (33 bytes) before the signature
// in a BOLT11 invoice, but parsing is complex. Instead, we extract it
// from the WWW-Authenticate header's invoice and decode the recovery ID.
// Simpler approach: GET the URL, read the 402 response, and try to
// extract the node key from the invoice via LND's decodepayreq.
// For now, we use a regex on the raw invoice (bech32) -- this is fragile
// but works for the initial version. Production should use bolt11 npm pkg.

/** Vague 3 Phase 2.6 - structured breakdown of why endpoints were skipped
 *  before the cap evaluation. Surfaced in the "Registry crawl complete" log
 *  to make the funnel observable in prod without re-running a manual audit.
 *
 *  Vague 3 Phase 2.7:
 *  - `protocol_x402` separates competing x402 (EVM/USDC) endpoints from
 *    L402 failures so we can see how much of the upstream catalogue is
 *    cross-listed with x402 (a meaningful share of "v2_tlv" entries on
 *    402index respond with `payment-required:` not `WWW-Authenticate:`).
 *  - `invalid_l402` is broken out into 4 sub-buckets so the next leverage
 *    point becomes visible: a missing BOLT11 in the header is a different
 *    fix from an LND decode failure. */
export interface PreCapSkipped {
  not_l402: number;
  unsafe_url: number;
  no_response: number;
  method_405_both: number;
  not_acceptable_406: number;
  not_402: number;
  fossil_404: number;
  /** Aggregate count, kept for backwards compatibility with prod dashboards. */
  invalid_l402: number;
  /** Vague 3 Phase 2.7 — sub-buckets of `invalid_l402` to expose where the
   *  L402 parsing actually fails. The four sum to `invalid_l402`. */
  invalid_l402_no_bolt11: number;
  invalid_l402_decode_failed: number;
  invalid_l402_invoice_malformed: number;
  invalid_l402_no_decoder: number;
  /** Vague 3 Phase 2.7 — endpoint speaks the competing x402 protocol
   *  (Coinbase USDC on EVM via `payment-required:` header). Not a SatRank
   *  failure; correctly rejected as out-of-scope. Surfacing the count makes
   *  cross-protocol dilution of 402index visible. */
  protocol_x402: number;
  other: number;
}

/** Vague 3 Phase 2.6 - last outcome of discoverNodeFromUrl, exposed to the
 *  caller via a class member so the run() loop can attribute non-success
 *  outcomes to the right pre_cap_skipped bucket without changing the return
 *  shape that other call sites (registerSelfSubmitted, tests) rely on.
 *  Vague 3 Phase 3: exported so the l402DirectoryCrawler can re-use the
 *  same primitive without copying the discovery logic. */
export interface DiscoveryOutcome {
  finalStatus: number;
  methodUsed: 'GET' | 'POST';
  reason: string;
}

/** Vague 3 Phase 3 — public-facing return shape for `RegistryCrawler.probeUrl`.
 *  Bundles discovery result and outcome so the l402DirectoryCrawler can
 *  bucket non-success cases identically to the registry crawl funnel. */
export interface ProbeResult {
  result: { agentHash: string; priceSats: number | null; latencyMs: number } | null;
  outcome: DiscoveryOutcome | null;
}

export class RegistryCrawler {
  private readonly hostLimiter = new HostRateLimiter(PER_HOST_GAP_MS);
  private readonly healthTracker: ProviderHealthTracker;
  /** Vague 3 phase 2 - configurable per-host cap. Defaults to
   *  HOST_INGESTION_CAP_PER_CYCLE for production. Tests use a small value to
   *  avoid burning the per-host rate limiter (500ms × N) on synthetic hosts. */
  private readonly hostIngestionCapPerCycle: number;
  private readonly absoluteHostCapTotal: number;
  /** Vague 3 Phase 2.6 - tracked across the full lifetime of one
   *  discoverNodeFromUrl call so the run() loop can categorise non-success
   *  outcomes for the pre_cap_skipped breakdown and the 404 deprecation
   *  logic. Reset at the top of every call. */
  private lastDiscoveryOutcome: DiscoveryOutcome | null = null;

  constructor(
    private serviceEndpointRepo: ServiceEndpointRepository,
    private decodeBolt11?: (invoice: string) => Promise<{ destination: string; num_satoshis?: string } | null>,
    private preimagePoolRepo?: PreimagePoolRepository,
    healthTracker?: ProviderHealthTracker,
    hostIngestionCapPerCycle: number = HOST_INGESTION_CAP_PER_CYCLE,
    absoluteHostCapTotal: number = ABSOLUTE_HOST_CAP_TOTAL,
  ) {
    this.healthTracker = healthTracker ?? new ProviderHealthTracker();
    this.hostIngestionCapPerCycle = hostIngestionCapPerCycle;
    this.absoluteHostCapTotal = absoluteHostCapTotal;
  }

  async run(): Promise<{
    discovered: number;
    updated: number;
    errors: number;
    capped: number;
    absoluteCapped: number;
    deprecatedFlagged: number;
    deprecatedCleared: number;
    preCapSkipped: PreCapSkipped;
  }> {
    const result = {
      discovered: 0,
      updated: 0,
      errors: 0,
      capped: 0,
      absoluteCapped: 0,
      deprecatedFlagged: 0,
      deprecatedCleared: 0,
      preCapSkipped: {
        not_l402: 0,
        unsafe_url: 0,
        no_response: 0,
        method_405_both: 0,
        not_acceptable_406: 0,
        not_402: 0,
        fossil_404: 0,
        invalid_l402: 0,
        invalid_l402_no_bolt11: 0,
        invalid_l402_decode_failed: 0,
        invalid_l402_invoice_malformed: 0,
        invalid_l402_no_decoder: 0,
        protocol_x402: 0,
        other: 0,
      } as PreCapSkipped,
    };
    let offset = 0;
    let hasMore = true;
    // Vague 3 phase 2 - per-host cap on NEW ingestions for this cycle. The
    // counter spans the entire run (all paginated pages) so the cap is a
    // global per-cycle budget, not a per-page budget.
    const newIngestionsByHost = new Map<string, number>();
    const absoluteCappedHosts = new Set<string>();
    // Vague 3 Phase 2.6 - existing per-host counts to enforce
    // ABSOLUTE_HOST_CAP_TOTAL. Built once at the top of the run and
    // incremented in-memory as we ingest, so we never re-query during the
    // hot loop.
    const existingByHost = await this.serviceEndpointRepo.countActiveByHost();

    /** Vague 3 Phase 2.6 - bucket a non-success outcome from
     *  discoverNodeFromUrl into the pre_cap_skipped breakdown.
     *
     *  Vague 3 Phase 2.7: invalid_l402 sub-buckets so a parser fix vs. a
     *  decoder fix can be told apart from the funnel log alone, and a
     *  dedicated `protocol_x402` bucket so 402index entries that turn out
     *  to be x402 (USDC/EVM) are not lumped with "real" L402 failures. */
    const bucketLastOutcome = (): void => {
      const o = this.lastDiscoveryOutcome;
      if (!o) return;
      switch (o.reason) {
        case 'method_405_both': result.preCapSkipped.method_405_both++; break;
        case 'not_acceptable_406': result.preCapSkipped.not_acceptable_406++; break;
        case 'fossil_404': result.preCapSkipped.fossil_404++; break;
        case 'not_402': result.preCapSkipped.not_402++; break;
        case 'protocol_x402': result.preCapSkipped.protocol_x402++; break;
        case 'invalid_l402_no_bolt11':
          result.preCapSkipped.invalid_l402++;
          result.preCapSkipped.invalid_l402_no_bolt11++;
          break;
        case 'invoice_malformed':
          result.preCapSkipped.invalid_l402++;
          result.preCapSkipped.invalid_l402_invoice_malformed++;
          break;
        case 'decode_failed':
          result.preCapSkipped.invalid_l402++;
          result.preCapSkipped.invalid_l402_decode_failed++;
          break;
        case 'no_decoder':
          result.preCapSkipped.invalid_l402++;
          result.preCapSkipped.invalid_l402_no_decoder++;
          break;
        case 'http_5xx':
        case 'network_error':
        case 'ssrf_blocked':
          result.preCapSkipped.no_response++; break;
        default: result.preCapSkipped.other++; break;
      }
    };

    while (hasMore) {
      try {
        const services = await this.fetchPage(offset);
        if (services.length === 0) {
          hasMore = false;
          break;
        }

        for (const svc of services) {
          if (svc.protocol !== 'L402') { result.preCapSkipped.not_l402++; continue; }
          if (!isSafeUrl(svc.url)) { result.preCapSkipped.unsafe_url++; continue; }
          try {
            const meta = {
              name: svc.name?.trim() || null,
              description: svc.description?.trim() || null,
              category: sanitizeCrawledCategory(svc.category, svc.url),
              provider: svc.provider?.trim() || null,
            };
            const httpMethod = normaliseHttpMethod(svc.http_method);

            // Update metadata for URLs already in the registry (even without decoder)
            const existing = await this.serviceEndpointRepo.findByUrl(svc.url);
            if (existing) {
              await this.serviceEndpointRepo.updateMetadata(svc.url, meta);
              // Vague 1 G.2: refresh upstream signals on every pass so a
              // changed reliability_score from 402index propagates fast.
              await this.serviceEndpointRepo.upsertUpstreamSignals(svc.url, {
                health_status: svc.health_status ?? null,
                uptime_30d: svc.uptime_30d ?? null,
                latency_p50_ms: svc.latency_p50_ms ?? null,
                reliability_score: svc.reliability_score ?? null,
                last_checked: parseIso(svc.last_checked),
                source: '402index',
              });
              // Phase 5.10A — persist http_method on every refresh. Idempotent
              // when the upstream value is unchanged. Drives /api/intent's
              // candidate.http_method exposure so SDK fulfill() picks the
              // correct method without a 405-fallback round-trip.
              if (existing.http_method !== httpMethod) {
                await this.serviceEndpointRepo.setHttpMethod(svc.url, httpMethod);
              }
              result.updated++;
              // Re-probe only if price is still null — avoid needless GET on healthy, priced endpoints
              if (existing.service_price_sats === null) {
                const probe = await this.discoverNodeFromUrl(svc.url, httpMethod);
                if (probe?.priceSats && probe.priceSats > 0) {
                  await this.serviceEndpointRepo.updatePrice(svc.url, probe.priceSats);
                }
                // Vague 3 Phase 2.6 — 404 fossile tracking on existing rows.
                // Only existing endpoints get this treatment; new URLs that
                // 404 on first contact are simply skipped (not yet in DB).
                const outcome = this.lastDiscoveryOutcome;
                if (outcome?.reason === 'fossil_404') {
                  const after = await this.serviceEndpointRepo.record404(svc.url, DEPRECATED_404_THRESHOLD);
                  if (after.deprecated && !existing.deprecated) {
                    result.deprecatedFlagged++;
                    logger.info({ url: svc.url, consecutive404: after.count, threshold: DEPRECATED_404_THRESHOLD }, 'Registry: endpoint flagged deprecated (404 streak)');
                  }
                } else if (outcome?.reason === 'success' && existing.consecutive_404_count > 0) {
                  await this.serviceEndpointRepo.clear404Streak(svc.url);
                  if (existing.deprecated) {
                    result.deprecatedCleared++;
                    logger.info({ url: svc.url }, 'Registry: deprecated cleared (endpoint recovered)');
                  }
                }
              }
              continue;
            }

            // Vague 3 Phase 2.6 - absolute host cap (lifetime). Prevents llm402
            // from ever exceeding ABSOLUTE_HOST_CAP_TOTAL endpoints in the
            // catalogue, regardless of how many cycles run. Checked before the
            // per-cycle cap so a host already at lifetime cap never enters
            // discoverNodeFromUrl this cycle either.
            const host = hostnameOf(svc.url);
            const lifetimeCount = existingByHost.get(host) ?? 0;
            if (lifetimeCount >= this.absoluteHostCapTotal) {
              result.absoluteCapped++;
              absoluteCappedHosts.add(host);
              continue;
            }

            // Vague 3 phase 2 - apply per-host cap to NEW ingestions only.
            // Updates above are unconditional so signal refresh keeps working
            // for all hosts, even those over the cap.
            const usedThisCycle = newIngestionsByHost.get(host) ?? 0;
            if (usedThisCycle >= this.hostIngestionCapPerCycle) {
              result.capped++;
              continue;
            }

            // New URL: discover the backing LN node, then upsert with the
            // confirmed bootstrap probe status (Vague 1 G.1). discoverNodeFromUrl
            // only returns a non-null result when the server actually responded
            // with HTTP 402 plus a decodable BOLT11, so persisting status=402 +
            // measured latencyMs replaces the legacy placeholder (0, 0) that
            // made every fresh row look "unreachable" until cold-tier had run.
            const discovered = await this.discoverNodeFromUrl(svc.url, httpMethod);
            if (discovered?.agentHash) {
              result.discovered++;
              newIngestionsByHost.set(host, usedThisCycle + 1);
              existingByHost.set(host, lifetimeCount + 1);
              await this.serviceEndpointRepo.upsert(
                discovered.agentHash,
                svc.url,
                402,
                discovered.latencyMs,
                '402index',
              );
              await this.serviceEndpointRepo.updateMetadata(svc.url, meta);
              // Vague 1 G.2: persist upstream quality signals from 402index.
              await this.serviceEndpointRepo.upsertUpstreamSignals(svc.url, {
                health_status: svc.health_status ?? null,
                uptime_30d: svc.uptime_30d ?? null,
                latency_p50_ms: svc.latency_p50_ms ?? null,
                reliability_score: svc.reliability_score ?? null,
                last_checked: parseIso(svc.last_checked),
                source: '402index',
              });
              // Phase 5.10A — persist http_method on initial ingestion. The
              // table default is 'GET'; we only write when the upstream value
              // differs from the default, avoiding redundant UPDATEs.
              if (httpMethod !== 'GET') {
                await this.serviceEndpointRepo.setHttpMethod(svc.url, httpMethod);
              }
              if (discovered.priceSats && discovered.priceSats > 0) {
                await this.serviceEndpointRepo.updatePrice(svc.url, discovered.priceSats);
              }
            } else {
              // Vague 3 Phase 2.6 - attribute the silent miss to the right
              // bucket so the cycle log breaks down where endpoints went.
              bucketLastOutcome();
            }
          } catch (err: unknown) {
            result.errors++;
            if (result.errors <= 10) {
              logger.warn({ url: svc.url, error: err instanceof Error ? err.message : String(err) }, 'Registry: failed to discover node for URL');
            }
          }
        }

        offset += services.length;
        if (services.length < PAGE_SIZE) hasMore = false;

        logger.info({ offset, discovered: result.discovered, updated: result.updated, capped: result.capped, absoluteCapped: result.absoluteCapped }, 'Registry crawl progress');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ offset, error: msg }, 'Registry crawl page fetch failed');
        result.errors++;
        hasMore = false; // stop on page-level failure
      }
    }

    // Surface which hosts actually got capped this cycle, ordered by hits, so
    // operators can spot concentration drift early.
    const cappedHosts = Array.from(newIngestionsByHost.entries())
      .filter(([, c]) => c >= this.hostIngestionCapPerCycle)
      .map(([h, c]) => ({ host: h, ingested: c }));
    logger.info({
      ...result,
      hostCapPerCycle: this.hostIngestionCapPerCycle,
      absoluteHostCapTotal: this.absoluteHostCapTotal,
      deprecatedThreshold: DEPRECATED_404_THRESHOLD,
      cappedHosts,
      absoluteCappedHosts: Array.from(absoluteCappedHosts),
    }, 'Registry crawl complete');
    return result;
  }

  private async fetchPage(offset: number): Promise<IndexService[]> {
    const url = `https://402index.io/api/v1/services?protocol=L402&limit=${PAGE_SIZE}&offset=${offset}`;
    await this.hostLimiter.wait(url);
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'SatRank-RegistryCrawler/1.0' },
    });
    if (!resp.ok) throw new Error(`402index returned ${resp.status}`);
    const data = await resp.json() as { services: IndexService[] };
    return data.services ?? [];
  }

  /** Public wrapper for ad-hoc submission via /api/services/register.
   *  Returns { agentHash, priceSats, fieldsUpdated } if valid L402 endpoint, null otherwise.
   *
   *  Anti-vandalism: self-register only fills EMPTY metadata fields. Existing data
   *  from 402index (the trusted crawler source) is never overwritten. This prevents
   *  a random submitter from renaming "Weather Intel: Forecast" to "test". */
  async registerSelfSubmitted(serviceUrl: string, meta?: { name?: string; description?: string; category?: string; provider?: string }): Promise<{ agentHash: string; priceSats: number | null; fieldsUpdated: string[] } | null> {
    if (!isSafeUrl(serviceUrl)) return null;
    const discovered = await this.discoverNodeFromUrl(serviceUrl);
    if (!discovered?.agentHash) return null;
    // Vague 1 G.1: persist confirmed 402 + measured latency at ingestion, same
    // semantics as the registry crawl path above. Self-submitted endpoints no
    // longer enter the catalogue as never-probed placeholders.
    await this.serviceEndpointRepo.upsert(
      discovered.agentHash,
      serviceUrl,
      402,
      discovered.latencyMs,
      'self_registered',
    );
    if (discovered.priceSats && discovered.priceSats > 0) {
      await this.serviceEndpointRepo.updatePrice(serviceUrl, discovered.priceSats);
    }

    const updated: string[] = [];
    if (meta) {
      const existing = await this.serviceEndpointRepo.findByUrl(serviceUrl);
      // Only fill fields that are currently null — never overwrite trusted crawler data
      const patch = {
        name: existing?.name ?? (meta.name?.trim() || null),
        description: existing?.description ?? (meta.description?.trim() || null),
        category: existing?.category ?? validateCategoryOrNull(meta.category),
        provider: existing?.provider ?? (meta.provider?.trim() || null),
      };
      // Track which fields actually changed
      if (!existing?.name && patch.name) updated.push('name');
      if (!existing?.description && patch.description) updated.push('description');
      if (!existing?.category && patch.category) updated.push('category');
      if (!existing?.provider && patch.provider) updated.push('provider');
      await this.serviceEndpointRepo.updateMetadata(serviceUrl, patch);
    }
    const ep = await this.serviceEndpointRepo.findByUrl(serviceUrl);
    return { agentHash: discovered.agentHash, priceSats: ep?.service_price_sats ?? null, fieldsUpdated: updated };
  }

  /** Vague 3 Phase 3 — public wrapper around `discoverNodeFromUrl` that
   *  returns the outcome alongside the result so external crawlers
   *  (l402DirectoryCrawler) can bucket non-success cases without re-implementing
   *  the discovery probe. */
  async probeUrl(url: string, method: 'GET' | 'POST' = 'GET'): Promise<ProbeResult> {
    const result = await this.discoverNodeFromUrl(url, method);
    return { result, outcome: this.lastDiscoveryOutcome };
  }

  /** GET (or POST) the service URL, expect a 402 with WWW-Authenticate header
   *  containing a BOLT11 invoice. Decode the invoice to extract the payee node
   *  pubkey and price in sats. Returns { agentHash, priceSats, latencyMs } or
   *  null. The latencyMs is the wall time of the discovery fetch and is reused
   *  as a bootstrap probe latency at upsert time so newly ingested rows enter
   *  the catalogue with confirmed status (Vague 1 G.1).
   *
   *  Vague 3 phase 2: the `method` argument carries the http_method 402index
   *  advertises for the endpoint.
   *
   *  Vague 3 Phase 2.6: symmetric 405 fallback (GET→POST or POST→GET) — the
   *  upstream registry sometimes mis-advertises the method (maximumsats lists
   *  POST but server expects GET). Plus an Accept header that prefers JSON
   *  but accepts anything (sats4ai's strict Content negotiation responds 406
   *  to */ /* alone). The outcome is exposed via `lastDiscoveryOutcome` so
   *  the run() loop can attribute null returns to the right pre_cap_skipped
   *  bucket and trigger 404 fossile flagging. */
  private async discoverNodeFromUrl(
    serviceUrl: string,
    method: 'GET' | 'POST' = 'GET',
  ): Promise<{ agentHash: string; priceSats: number | null; latencyMs: number } | null> {
    this.lastDiscoveryOutcome = null;
    const start = Date.now();
    try {
      await this.hostLimiter.wait(serviceUrl);
      // SSRF hardening: fetchSafeExternal does connect-time DNS validation so a
      // user-controlled URL that rebinds to a private IP is rejected before
      // the socket opens. redirect: 'manual' is the default (no follow).
      const buildInit = (m: 'GET' | 'POST'): RequestInit => ({
        method: m,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': 'SatRank-RegistryCrawler/1.0',
          // Vague 3 Phase 2.6 — Accept JSON but accept anything as fallback so
          // strict content-negotiation servers (sats4ai responds 406 to */* alone)
          // don't 406-reject the probe.
          'Accept': 'application/json, */*;q=0.5',
          ...(m === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(m === 'POST' ? { body: '{}' } : {}),
      });

      let resp = await fetchSafeExternal(serviceUrl, buildInit(method));
      let methodUsed: 'GET' | 'POST' = method;
      // Vague 3 Phase 2.6: symmetric 405 fallback. If the first call returned
      // 405 Method Not Allowed (regardless of which method we tried), retry
      // with the opposite. Covers both llm402.ai (advertised GET, needs POST)
      // and maximumsats (advertised POST, needs GET).
      if (resp.status === 405) {
        const altMethod: 'GET' | 'POST' = method === 'GET' ? 'POST' : 'GET';
        logger.info({ url: serviceUrl, initialMethod: method, fallbackMethod: altMethod }, 'discoverNodeFromUrl: 405 fallback');
        resp = await fetchSafeExternal(serviceUrl, buildInit(altMethod));
        methodUsed = altMethod;
      }
      const latencyMs = Date.now() - start;

      if (resp.status === 405) {
        // Both methods returned 405 — endpoint accepts neither, skip.
        this.lastDiscoveryOutcome = { finalStatus: 405, methodUsed, reason: 'method_405_both' };
        logger.info({ url: serviceUrl, methodUsed }, 'discoverNodeFromUrl: 405 on both methods');
        return null;
      }
      if (resp.status === 406) {
        this.lastDiscoveryOutcome = { finalStatus: 406, methodUsed, reason: 'not_acceptable_406' };
        logger.info({ url: serviceUrl, methodUsed }, 'discoverNodeFromUrl: 406 not acceptable');
        return null;
      }
      if (resp.status === 404) {
        this.lastDiscoveryOutcome = { finalStatus: 404, methodUsed, reason: 'fossil_404' };
        logger.info({ url: serviceUrl, methodUsed }, 'discoverNodeFromUrl: 404 (potential fossil)');
        return null;
      }
      if (resp.status >= 500 && resp.status < 600) {
        // 5xx on a URL 402index has indexed is a provider-side failure: track it
        // so an outage like the 2026-04-22 plebtv one surfaces in the logs.
        this.healthTracker.recordFailure(serviceUrl, 'http_5xx_after_retry');
        this.lastDiscoveryOutcome = { finalStatus: resp.status, methodUsed, reason: 'http_5xx' };
        logger.info({ url: serviceUrl, methodUsed, status: resp.status }, 'discoverNodeFromUrl: 5xx');
        return null;
      }
      if (resp.status !== 402) {
        this.lastDiscoveryOutcome = { finalStatus: resp.status, methodUsed, reason: 'not_402' };
        logger.info({ url: serviceUrl, methodUsed, status: resp.status }, 'discoverNodeFromUrl: non-402');
        return null; // not an L402 endpoint (legit non-L402)
      }

      // Vague 3 Phase 2.7 — x402 protocol detection. A meaningful share of
      // 402index entries flagged `l402_format=v2_tlv` (notably llm402.ai's
      // 500+ entries plus api.myceliasignal.com, x402.robtex.com, etc.) are
      // actually x402 (Coinbase USDC on EVM) responding with a `payment-required:`
      // header instead of `WWW-Authenticate: L402 ...`. They cannot be ingested
      // as Lightning endpoints — there is no BOLT11 — so we honestly bucket
      // them rather than letting them dilute `invalid_l402`. The header presence
      // is unambiguous: x402 servers always set it and L402 servers never do.
      if (resp.headers.has('payment-required')) {
        this.lastDiscoveryOutcome = { finalStatus: 402, methodUsed, reason: 'protocol_x402' };
        logger.info({ url: serviceUrl, methodUsed }, 'discoverNodeFromUrl: x402 protocol (USDC/EVM, not Lightning)');
        return null;
      }

      const wwwAuth = resp.headers.get('www-authenticate') ?? '';
      // Extract invoice from: L402 macaroon="...", invoice="lnbc..."
      const invoiceMatch = wwwAuth.match(/invoice="(lnbc[a-z0-9]+)"/i);
      if (!invoiceMatch) {
        // Vague 3 Phase 2.7 — log this so future investigations can see what
        // the WWW-Authenticate actually looks like when parsing fails. Truncate
        // the header to keep the log line bounded; full content stays on the
        // wire (curl reproduces).
        this.lastDiscoveryOutcome = { finalStatus: 402, methodUsed, reason: 'invalid_l402_no_bolt11' };
        logger.info(
          { url: serviceUrl, methodUsed, wwwAuthSample: wwwAuth.slice(0, 200) },
          'discoverNodeFromUrl: 402 with no decodable BOLT11 in WWW-Authenticate',
        );
        return null;
      }

      const invoice = invoiceMatch[1];

      // Phase 2 voie 1 : alimente preimage_pool dès qu'on voit un BOLT11.
      // Idempotent (INSERT OR IGNORE) ; errors non-fatales (log only).
      if (this.preimagePoolRepo) {
        try {
          const parsed = parseBolt11(invoice);
          await this.preimagePoolRepo.insertIfAbsent({
            paymentHash: parsed.paymentHash,
            bolt11Raw: invoice,
            firstSeen: Math.floor(Date.now() / 1000),
            confidenceTier: 'medium',
            source: 'crawler',
          });
        } catch (err) {
          if (!(err instanceof InvalidBolt11Error)) {
            logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Registry: preimage_pool insert failed');
          }
        }
      }

      // Use the provided BOLT11 decoder (LND decodepayreq) if available
      if (this.decodeBolt11) {
        try {
          const decoded = await this.decodeBolt11(invoice);
          if (decoded?.destination) {
            const agentHash = sha256(decoded.destination);
            const priceSats = decoded.num_satoshis ? parseInt(decoded.num_satoshis, 10) : null;
            this.healthTracker.recordSuccess(serviceUrl);
            this.lastDiscoveryOutcome = { finalStatus: 402, methodUsed, reason: 'success' };
            return { agentHash, priceSats: priceSats && priceSats > 0 ? priceSats : null, latencyMs };
          }
          this.healthTracker.recordFailure(serviceUrl, 'decode_failed');
          this.lastDiscoveryOutcome = { finalStatus: 402, methodUsed, reason: 'decode_failed' };
        } catch (decodeErr: unknown) {
          const msg = decodeErr instanceof Error ? decodeErr.message : String(decodeErr);
          const kind = /invalid index|checksum failed|failed converting data|invalid character not part of charset/i.test(msg)
            ? 'invoice_malformed'
            : 'decode_failed';
          this.healthTracker.recordFailure(serviceUrl, kind);
          this.lastDiscoveryOutcome = { finalStatus: 402, methodUsed, reason: kind };
        }
      } else {
        this.lastDiscoveryOutcome = { finalStatus: 402, methodUsed, reason: 'no_decoder' };
      }

      return null;
    } catch (err: unknown) {
      if (err instanceof SsrfBlockedError) {
        logger.debug({ url: serviceUrl, reason: err.message }, 'Registry: discoverNodeFromUrl blocked by SSRF guard');
        this.lastDiscoveryOutcome = { finalStatus: 0, methodUsed: method, reason: 'ssrf_blocked' };
      } else {
        this.healthTracker.recordFailure(serviceUrl, 'network_error');
        this.lastDiscoveryOutcome = { finalStatus: 0, methodUsed: method, reason: 'network_error' };
      }
      return null;
    }
  }

}
