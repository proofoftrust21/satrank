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

/** Vague 3 phase 2 - cap on NEW ingestions per host per cycle.
 *
 *  Without this, ingesting llm402.ai (444 endpoints discovered today by the
 *  POST fallback) in a single cycle would push the catalog from 33% top-host
 *  concentration (grid.ptsolutions, 74/220) to 57% (llm402, 444 of ~755).
 *  That spike would be a regression on a property the team cares about, and
 *  it would land before any operator outreach has had time to bring in
 *  diversity from /api/services/register.
 *
 *  We cap NEW URLs to 50 per host per cycle. Updates to URLs already in the
 *  catalogue (metadata refresh, upstream signals refresh) are not capped.
 *  At the default cron interval of 24h, llm402.ai's 444 endpoints get
 *  ingested over ~9 days, smoothing the concentration ramp. Operators can
 *  trigger more cycles manually if a faster ramp is needed. */
const HOST_INGESTION_CAP_PER_CYCLE = 50;

// Minimal BOLT11 payee extraction without external dependency.
// The payee pubkey is the last 264 bits (33 bytes) before the signature
// in a BOLT11 invoice, but parsing is complex. Instead, we extract it
// from the WWW-Authenticate header's invoice and decode the recovery ID.
// Simpler approach: GET the URL, read the 402 response, and try to
// extract the node key from the invoice via LND's decodepayreq.
// For now, we use a regex on the raw invoice (bech32) -- this is fragile
// but works for the initial version. Production should use bolt11 npm pkg.

export class RegistryCrawler {
  private readonly hostLimiter = new HostRateLimiter(PER_HOST_GAP_MS);
  private readonly healthTracker: ProviderHealthTracker;
  /** Vague 3 phase 2 - configurable per-host cap. Defaults to
   *  HOST_INGESTION_CAP_PER_CYCLE for production. Tests use a small value to
   *  avoid burning the per-host rate limiter (500ms × N) on synthetic hosts. */
  private readonly hostIngestionCapPerCycle: number;

  constructor(
    private serviceEndpointRepo: ServiceEndpointRepository,
    private decodeBolt11?: (invoice: string) => Promise<{ destination: string; num_satoshis?: string } | null>,
    private preimagePoolRepo?: PreimagePoolRepository,
    healthTracker?: ProviderHealthTracker,
    hostIngestionCapPerCycle: number = HOST_INGESTION_CAP_PER_CYCLE,
  ) {
    this.healthTracker = healthTracker ?? new ProviderHealthTracker();
    this.hostIngestionCapPerCycle = hostIngestionCapPerCycle;
  }

  async run(): Promise<{ discovered: number; updated: number; errors: number; capped: number }> {
    const result = { discovered: 0, updated: 0, errors: 0, capped: 0 };
    let offset = 0;
    let hasMore = true;
    // Vague 3 phase 2 - per-host cap on NEW ingestions for this cycle. The
    // counter spans the entire run (all paginated pages) so the cap is a
    // global per-cycle budget, not a per-page budget.
    const newIngestionsByHost = new Map<string, number>();

    while (hasMore) {
      try {
        const services = await this.fetchPage(offset);
        if (services.length === 0) {
          hasMore = false;
          break;
        }

        for (const svc of services) {
          if (svc.protocol !== 'L402') continue;
          if (!isSafeUrl(svc.url)) continue;
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
              result.updated++;
              // Re-probe only if price is still null — avoid needless GET on healthy, priced endpoints
              if (existing.service_price_sats === null) {
                const probe = await this.discoverNodeFromUrl(svc.url, httpMethod);
                if (probe?.priceSats && probe.priceSats > 0) {
                  await this.serviceEndpointRepo.updatePrice(svc.url, probe.priceSats);
                }
              }
              continue;
            }

            // Vague 3 phase 2 - apply per-host cap to NEW ingestions only.
            // Updates above are unconditional so signal refresh keeps working
            // for all hosts, even those over the cap.
            const host = hostnameOf(svc.url);
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
              if (discovered.priceSats && discovered.priceSats > 0) {
                await this.serviceEndpointRepo.updatePrice(svc.url, discovered.priceSats);
              }
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

        logger.info({ offset, discovered: result.discovered, updated: result.updated, capped: result.capped }, 'Registry crawl progress');
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
    logger.info({ ...result, hostCapPerCycle: this.hostIngestionCapPerCycle, cappedHosts }, 'Registry crawl complete');
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

  /** GET (or POST) the service URL, expect a 402 with WWW-Authenticate header
   *  containing a BOLT11 invoice. Decode the invoice to extract the payee node
   *  pubkey and price in sats. Returns { agentHash, priceSats, latencyMs } or
   *  null. The latencyMs is the wall time of the discovery fetch and is reused
   *  as a bootstrap probe latency at upsert time so newly ingested rows enter
   *  the catalogue with confirmed status (Vague 1 G.1).
   *
   *  Vague 3 phase 2: the `method` argument carries the http_method 402index
   *  advertises for the endpoint. When 'POST' we send POST directly with an
   *  empty JSON body. When 'GET' we send GET first and retry with POST on a
   *  405 response, because the upstream may omit http_method for legacy
   *  entries — losing 444 llm402.ai endpoints to silent rejection in the
   *  pre-Vague-3 crawler. POST retries always carry Content-Type:
   *  application/json + body '{}' so endpoints that validate Content-Length>0
   *  don't reject the probe at the WAF. */
  private async discoverNodeFromUrl(
    serviceUrl: string,
    method: 'GET' | 'POST' = 'GET',
  ): Promise<{ agentHash: string; priceSats: number | null; latencyMs: number } | null> {
    const start = Date.now();
    try {
      await this.hostLimiter.wait(serviceUrl);
      // SSRF hardening: fetchSafeExternal does connect-time DNS validation so a
      // user-controlled URL that rebinds to a private IP is rejected before
      // the socket opens. redirect: 'manual' is the default (no follow).
      const buildInit = (m: 'GET' | 'POST'): RequestInit => ({
        method: m,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: m === 'POST'
          ? { 'User-Agent': 'SatRank-RegistryCrawler/1.0', 'Content-Type': 'application/json' }
          : { 'User-Agent': 'SatRank-RegistryCrawler/1.0' },
        ...(m === 'POST' ? { body: '{}' } : {}),
      });

      let resp = await fetchSafeExternal(serviceUrl, buildInit(method));
      let methodUsed: 'GET' | 'POST' = method;
      // Vague 3 phase 2: GET-first POST-fallback. If the upstream registry did
      // not advertise POST and the endpoint replies 405 Method Not Allowed,
      // try POST once with an empty JSON body. llm402.ai is the canonical case.
      if (resp.status === 405 && method === 'GET') {
        logger.debug({ url: serviceUrl }, 'Registry: GET returned 405, retrying with POST');
        resp = await fetchSafeExternal(serviceUrl, buildInit('POST'));
        methodUsed = 'POST';
      }
      const latencyMs = Date.now() - start;

      if (resp.status >= 500 && resp.status < 600) {
        // 5xx on a URL 402index has indexed is a provider-side failure: track it
        // so an outage like the 2026-04-22 plebtv one surfaces in the logs.
        this.healthTracker.recordFailure(serviceUrl, 'http_5xx_after_retry');
        logger.debug({ url: serviceUrl, methodUsed, status: resp.status }, 'Registry: discoverNodeFromUrl 5xx');
        return null;
      }
      if (resp.status !== 402) {
        logger.debug({ url: serviceUrl, methodUsed, status: resp.status }, 'Registry: discoverNodeFromUrl non-402 response');
        return null; // not an L402 endpoint (legit non-L402)
      }

      const wwwAuth = resp.headers.get('www-authenticate') ?? '';
      // Extract invoice from: L402 macaroon="...", invoice="lnbc..."
      const invoiceMatch = wwwAuth.match(/invoice="(lnbc[a-z0-9]+)"/i);
      if (!invoiceMatch) return null;

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
            return { agentHash, priceSats: priceSats && priceSats > 0 ? priceSats : null, latencyMs };
          }
          this.healthTracker.recordFailure(serviceUrl, 'decode_failed');
        } catch (decodeErr: unknown) {
          const msg = decodeErr instanceof Error ? decodeErr.message : String(decodeErr);
          const kind = /invalid index|checksum failed|failed converting data|invalid character not part of charset/i.test(msg)
            ? 'invoice_malformed'
            : 'decode_failed';
          this.healthTracker.recordFailure(serviceUrl, kind);
        }
      }

      return null;
    } catch (err: unknown) {
      if (err instanceof SsrfBlockedError) {
        logger.debug({ url: serviceUrl, reason: err.message }, 'Registry: discoverNodeFromUrl blocked by SSRF guard');
      } else {
        this.healthTracker.recordFailure(serviceUrl, 'network_error');
      }
      return null;
    }
  }

}
