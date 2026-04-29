// Pricing Mix A+D — synchronous fresh-probe service.
//
// Used by /api/intent?fresh=true (paid 2 sats) to guarantee that the top-N
// candidates we surface have a `last_checked_at` younger than the hot-tier
// freshness window. The probe is best-effort per URL — a network failure on
// one target does not abort the batch. Each successful probe upserts a new
// last_checked_at + last_http_status + check/success counters via the same
// path the periodic crawler uses, so there is no semantic divergence between
// scheduled probes and on-demand probes.
//
// SSRF protection is delegated to fetchSafeExternal: the caller must never
// hand a user-controlled URL through here without going through canonical
// trust filtering. The only callers today are intent resolution (URLs come
// from the trusted service_endpoints catalogue) and tests.

import { fetchSafeExternal, SsrfBlockedError } from '../utils/ssrf';
import { logger } from '../logger';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';

export const FRESH_PROBE_TIMEOUT_MS = 5_000;
export const FRESH_PROBE_CONCURRENCY = 5;

export interface FreshProbeResult {
  url: string;
  status: number;
  latency_ms: number;
  healthy: boolean;
  error?: string;
}

export async function probeUrlsNow(
  urls: string[],
  repo: ServiceEndpointRepository,
): Promise<FreshProbeResult[]> {
  if (urls.length === 0) return [];

  const probe = async (url: string): Promise<FreshProbeResult> => {
    const start = Date.now();
    try {
      // Audit r3 — read http_method from catalogue BEFORE the fetch so the
      // synchronous probe respects POST-only endpoints (llm402.ai etc).
      // Without this, agents who pay 2 sats for a fresh probe of a
      // POST-only endpoint receive a 405 result and the persisted
      // last_http_status is wrong for everyone downstream.
      const endpointPre = await repo.findByUrl(url);
      const method = endpointPre?.http_method ?? 'GET';
      const resp = await fetchSafeExternal(url, {
        method,
        signal: AbortSignal.timeout(FRESH_PROBE_TIMEOUT_MS),
        headers: {
          'User-Agent': 'SatRank-FreshProbe/1.0',
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      const latencyMs = Date.now() - start;
      const status = resp.status;
      const healthy = status === 402 || (status >= 200 && status < 300);
      const agentHash = endpointPre?.agent_hash ?? null;
      const source = endpointPre?.source ?? 'ad_hoc';
      await repo.upsert(agentHash, url, status, latencyMs, source);
      return { url, status, latency_ms: latencyMs, healthy };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const message =
        err instanceof SsrfBlockedError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'unknown';
      try {
        const endpoint = await repo.findByUrl(url);
        const agentHash = endpoint?.agent_hash ?? null;
        const source = endpoint?.source ?? 'ad_hoc';
        await repo.upsert(agentHash, url, 0, latencyMs, source);
      } catch (upsertErr) {
        logger.warn(
          { url, err: upsertErr instanceof Error ? upsertErr.message : String(upsertErr) },
          'fresh probe upsert failed after fetch error',
        );
      }
      return { url, status: 0, latency_ms: latencyMs, healthy: false, error: message };
    }
  };

  const results: FreshProbeResult[] = [];
  for (let i = 0; i < urls.length; i += FRESH_PROBE_CONCURRENCY) {
    const chunk = urls.slice(i, i + FRESH_PROBE_CONCURRENCY);
    results.push(...(await Promise.all(chunk.map(probe))));
  }
  return results;
}
