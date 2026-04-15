// Registry crawler -- discovers L402 endpoints from 402index.io,
// extracts payee_node_key from BOLT11 invoices, maps URL -> LN node.
// Populates service_endpoints without paying any invoices.
import { logger } from '../logger';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import { sha256 } from '../utils/crypto';
import { isSafeUrl } from '../utils/ssrf';

interface IndexService {
  url: string;
  protocol: string;
  name?: string;
  description?: string;
  category?: string;
  provider?: string;
}

// Normalize 402index categories (inconsistent: "ai/ml", "AI", "ai/llm", etc.)
const CATEGORY_MAP: Record<string, string> = {
  'ai': 'ai',
  'ai/ml': 'ai',
  'ai/llm': 'ai',
  'ai/agents': 'ai',
  'ai/embeddings': 'ai',
  'data': 'data',
  'data/oracle': 'data',
  'real-time-data': 'data',
  'crypto/prices': 'data',
  'tools': 'tools',
  'tools/directory': 'tools',
  'bitcoin': 'bitcoin',
  'lightning': 'bitcoin',
  'media': 'media',
  'social': 'social',
  'earn/cashback': 'earn',
  'earn/optimization': 'earn',
};

function normalizeCategory(raw: string | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  return CATEGORY_MAP[key] ?? key;
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
              category: normalizeCategory(svc.category),
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
              this.serviceEndpointRepo.upsert(agentHash, svc.url, 0, 0);
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

  /** GET the service URL, expect a 402 with WWW-Authenticate header containing a BOLT11 invoice.
   *  Decode the invoice to extract the payee node pubkey. Return SHA256(pubkey) as agent_hash. */
  private async discoverNodeFromUrl(serviceUrl: string): Promise<string | null> {
    try {
      const resp = await fetch(serviceUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'SatRank-RegistryCrawler/1.0' },
        redirect: 'manual', // SSRF: don't follow redirects (could chain to internal IPs)
      });

      if (resp.status !== 402) return null; // not an L402 endpoint

      const wwwAuth = resp.headers.get('www-authenticate') ?? '';
      // Extract invoice from: L402 macaroon="...", invoice="lnbc..."
      const invoiceMatch = wwwAuth.match(/invoice="(lnbc[a-z0-9]+)"/i);
      if (!invoiceMatch) return null;

      const invoice = invoiceMatch[1];

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
    } catch {
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
