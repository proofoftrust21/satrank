// Prometheus metrics middleware and registry
import client from 'prom-client';
import type { Request, Response, NextFunction } from 'express';

// Custom registry (avoids polluting default)
export const metricsRegistry = new client.Registry();
metricsRegistry.setDefaultLabels({ app: 'satrank' });

// Collect default Node.js metrics (event loop, memory, GC)
client.collectDefaultMetrics({ register: metricsRegistry });

// --- Application gauges (updated by statsService) ---

export const agentsTotal = new client.Gauge({
  name: 'satrank_agents_total',
  help: 'Total number of indexed agents',
  registers: [metricsRegistry],
});

export const transactionsTotal = new client.Gauge({
  name: 'satrank_transactions_total',
  help: 'Total number of transactions',
  registers: [metricsRegistry],
});

// --- Request counter ---

export const requestsTotal = new client.Counter({
  name: 'satrank_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [metricsRegistry],
});

// --- Histograms ---

export const httpRequestDuration = new client.Histogram({
  name: 'satrank_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

export const scoreComputeDuration = new client.Histogram({
  name: 'satrank_score_compute_duration_seconds',
  help: 'Score computation duration in seconds',
  registers: [metricsRegistry],
});

export const crawlDuration = new client.Histogram({
  name: 'satrank_crawl_duration_seconds',
  help: 'Crawler run duration in seconds',
  labelNames: ['source'] as const,
  buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [metricsRegistry],
});

// --- HTTP metrics middleware ---

function normalizeRoute(req: Request): string {
  // Use the matched route pattern if available, else a fixed label
  if (req.route) {
    return req.baseUrl + req.route.path;
  }
  // Unmatched routes: fixed label to prevent high-cardinality label explosion
  return 'unmatched';
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSec = durationNs / 1e9;
    const route = normalizeRoute(req);
    const labels = { method: req.method, route, status: String(res.statusCode) };

    requestsTotal.inc(labels);
    httpRequestDuration.observe(labels, durationSec);
  });

  next();
}
