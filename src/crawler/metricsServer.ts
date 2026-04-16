// Minimal HTTP server exposing /metrics and /healthz for the crawler process.
//
// The crawler writes to the shared `metricsRegistry` (crawlDuration, probe
// counts, Nostr publish stats once wired) but owns no HTTP listener — so
// Prometheus has no way to reach the data. This module adds exactly one
// endpoint plus a liveness probe that external monitoring can hit.
//
// Auth model mirrors the api container: localhost access is free (docker
// sidecar / SSH tunnel), external access requires X-API-Key. The /healthz
// endpoint is always open (Docker healthcheck + external liveness).
import http from 'node:http';
import { metricsRegistry } from '../middleware/metrics';
import { logger } from '../logger';
import { config } from '../config';
import { safeEqual } from '../middleware/auth';

/** Per-IP token-bucket rate limiter for /metrics. Audit H6 noted the endpoint
 *  had no rate limit on the crawler side either, making brute force on the
 *  API_KEY trivial. 30 req/min/IP accommodates aggressive Prometheus scraping
 *  (1× / 15s from multiple replicas) while shutting down cleartext brute force. */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
interface Bucket { count: number; resetAt: number; }
const buckets = new Map<string, Bucket>();
function checkRate(ip: string): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now >= b.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    // Opportunistic eviction — keep the map bounded under sustained load
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) { if (now >= v.resetAt) buckets.delete(k); }
    }
    return true;
  }
  if (b.count >= RATE_LIMIT_MAX) return false;
  b.count++;
  return true;
}

export interface CrawlerMetricsServerOptions {
  port: number;
  host?: string;
}

/** Tight list of addresses we accept for the "localhost bypass" — mirrors
 *  the api container's rule. Docker's bridge gateway (172.*) is NOT in this
 *  set: if the API container scrapes the crawler, it must send X-API-Key. */
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function startCrawlerMetricsServer(opts: CrawlerMetricsServerOptions): http.Server {
  const server = http.createServer(async (req, res) => {
    // Strip query string so /metrics?instance=crawler also matches (audit M6).
    const path = (req.url ?? '').split('?')[0];

    // Only /metrics and /healthz are served — everything else returns 404.
    if (path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok\n');
      return;
    }

    if (path !== '/metrics') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found\n');
      return;
    }

    // Auth: localhost OR valid X-API-Key. Constant-time compare + rate limit
    // shut down the brute-force surface flagged as audit C2 / H6.
    const ip = req.socket.remoteAddress ?? '';
    const isLocalhost = LOOPBACK_IPS.has(ip);
    if (!isLocalhost) {
      if (!checkRate(ip)) {
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        res.end('Too many metrics requests\n');
        return;
      }
      const apiKeyHeader = req.headers['x-api-key'];
      const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
      if (!safeEqual(apiKey, config.API_KEY)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden — use localhost or X-API-Key\n');
        return;
      }
    }

    try {
      const body = await metricsRegistry.metrics();
      res.writeHead(200, { 'Content-Type': metricsRegistry.contentType });
      res.end(body);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg }, 'Crawler metrics scrape failed');
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('internal error\n');
    }
  });

  const host = opts.host ?? '0.0.0.0';
  server.listen(opts.port, host, () => {
    logger.info({ host, port: opts.port }, 'Crawler metrics server listening');
  });

  // Crash-tolerant: if the socket fails (e.g. port already bound), log and
  // continue — the crawler loop must not die because of an observability
  // channel. /metrics becomes unavailable but the crawler still runs.
  server.on('error', (err: Error) => {
    logger.error({ error: err.message, port: opts.port }, 'Crawler metrics server error');
  });

  return server;
}
