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
import { parseBolt11, InvalidBolt11Error } from '../utils/bolt11Parser';
import { validateCategoryOrNull } from '../utils/categoryValidation';

interface IndexService {
  url: string;
  protocol: string;
  name?: string;
  description?: string;
  category?: string;
  provider?: string;
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
const RATE_LIMIT_MS = 500; // 2 req/sec to avoid overloading 402index
const FETCH_TIMEOUT_MS = 5000;

// Minimal BOLT11 payee extraction without external dependency.
// The payee pubkey is the last 264 bits (33 bytes) before the signature
// in a BOLT11 invoice, but parsing is complex. Instead, we extract it
// from the WWW-Authenticate header's invoice and decode the recovery ID.
// Simpler approach: GET the URL, read the 402 response, and try to
// extract the node key from the invoice via LND's decodepayreq.
// For now, we use a regex on the raw invoice (bech32) -- this is fragile
// but works for the initial version. Production should use bolt11 npm pkg.

export class RegistryCrawler {
  constructor(
    private serviceEndpointRepo: ServiceEndpointRepository,
    private decodeBolt11?: (invoice: string) => Promise<{ destination: string; num_satoshis?: string } | null>,
    private preimagePoolRepo?: PreimagePoolRepository,
  ) {}

  async run(): Promise<{ discovered: number; updated: number; errors: number }> {
    const result = { discovered: 0, updated: 0, errors: 0 };
    let offset = 0;
    let hasMore = true;

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

            // Update metadata for URLs already in the registry (even without decoder)
            const existing = this.serviceEndpointRepo.findByUrl(svc.url);
            if (existing) {
              this.serviceEndpointRepo.updateMetadata(svc.url, meta);
              result.updated++;
              continue; // already registered, skip node discovery
            }

            // New URL — try to discover the backing LN node
            const agentHash = await this.discoverNodeFromUrl(svc.url);
            if (agentHash) {
              result.discovered++;
              this.serviceEndpointRepo.upsert(agentHash, svc.url, 0, 0, '402index');
              this.serviceEndpointRepo.updateMetadata(svc.url, meta);
            }
          } catch (err: unknown) {
            result.errors++;
            if (result.errors <= 10) {
              logger.warn({ url: svc.url, error: err instanceof Error ? err.message : String(err) }, 'Registry: failed to discover node for URL');
            }
          }
          await this.sleep(RATE_LIMIT_MS);
        }

        offset += services.length;
        if (services.length < PAGE_SIZE) hasMore = false;

        logger.info({ offset, discovered: result.discovered, updated: result.updated }, 'Registry crawl progress');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ offset, error: msg }, 'Registry crawl page fetch failed');
        result.errors++;
        hasMore = false; // stop on page-level failure
      }
    }

    logger.info(result, 'Registry crawl complete');
    return result;
  }

  private async fetchPage(offset: number): Promise<IndexService[]> {
    const url = `https://402index.io/api/v1/services?protocol=L402&limit=${PAGE_SIZE}&offset=${offset}`;
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
    const agentHash = await this.discoverNodeFromUrl(serviceUrl);
    if (!agentHash) return null;
    this.serviceEndpointRepo.upsert(agentHash, serviceUrl, 0, 0, 'self_registered');

    const updated: string[] = [];
    if (meta) {
      const existing = this.serviceEndpointRepo.findByUrl(serviceUrl);
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
      this.serviceEndpointRepo.updateMetadata(serviceUrl, patch);
    }
    const ep = this.serviceEndpointRepo.findByUrl(serviceUrl);
    return { agentHash, priceSats: ep?.service_price_sats ?? null, fieldsUpdated: updated };
  }

  /** GET the service URL, expect a 402 with WWW-Authenticate header containing a BOLT11 invoice.
   *  Decode the invoice to extract the payee node pubkey. Return SHA256(pubkey) as agent_hash. */
  private async discoverNodeFromUrl(serviceUrl: string): Promise<string | null> {
    try {
      // SSRF hardening: fetchSafeExternal does connect-time DNS validation so a
      // user-controlled URL that rebinds to a private IP is rejected before
      // the socket opens. redirect: 'manual' is the default (no follow).
      const resp = await fetchSafeExternal(serviceUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'SatRank-RegistryCrawler/1.0' },
      });

      if (resp.status !== 402) return null; // not an L402 endpoint

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
          this.preimagePoolRepo.insertIfAbsent({
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
        const decoded = await this.decodeBolt11(invoice);
        if (decoded?.destination) {
          const agentHash = sha256(decoded.destination);
          // Store the price from the invoice
          const priceSats = decoded.num_satoshis ? parseInt(decoded.num_satoshis, 10) : null;
          if (priceSats && priceSats > 0) {
            this.serviceEndpointRepo.updatePrice(serviceUrl, priceSats);
          }
          return agentHash;
        }
      }

      return null;
    } catch (err: unknown) {
      if (err instanceof SsrfBlockedError) {
        logger.debug({ url: serviceUrl, reason: err.message }, 'Registry: discoverNodeFromUrl blocked by SSRF guard');
      }
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
