// Phase 12A A4 — k6 smoke for GET /api/health.
// Purpose: lightest-possible endpoint, establishes the instrumentation+network
// ceiling. If health p95 degrades, the rest of the run is suspect.
//
// Usage (from staging host to avoid WAN in the path):
//   BASE_URL=http://localhost:8080 RPS=100 DURATION=10m k6 run bench/k6/health.js
//
// Env:
//   BASE_URL  — staging api base URL (default: http://localhost:8080)
//   RPS       — target arrival rate per second (default: 10)
//   DURATION  — sustained duration (default: 10m)
//   WARMUP    — warmup ramp-up duration (default: 5m)
//   REST      — rest after sustained (default: 2m, used only when the
//               orchestrator (bench/run-all.sh) does not batch windows)
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const RPS = Number(__ENV.RPS || 10);
const DURATION = __ENV.DURATION || '10m';
const WARMUP = __ENV.WARMUP || '5m';

// Custom metrics for dashboards
const healthLatency = new Trend('satrank_bench_health_latency_ms', true);
const healthOk = new Rate('satrank_bench_health_ok');

export const options = {
  discardResponseBodies: true,
  scenarios: {
    health: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: Math.max(50, RPS * 2),
      maxVUs: Math.max(100, RPS * 4),
      stages: [
        { duration: WARMUP, target: RPS },
        { duration: DURATION, target: RPS },
      ],
      tags: { endpoint: 'health' },
    },
  },
  thresholds: {
    // Soft thresholds — don't fail the run on threshold violation so the
    // full palier sweep completes; we interpret the trend data in A7.
    'satrank_bench_health_ok': ['rate>0.99'],
    'satrank_bench_health_latency_ms': ['p(95)<200'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/api/health`);
  healthLatency.add(res.timings.duration);
  // On staging the crawler is deliberately stopped (frozen DB clone), so
  // /api/health returns 503 with `scoringStale: true`. That's a property of
  // the bench topology, not a failure of the server. Treat 200 and 503 as
  // "server responded" for the ok rate; real failures = connection errors,
  // timeouts, 4xx, or 5xx other than 503.
  const served = res.status === 200 || res.status === 503;
  healthOk.add(served);
  check(res, { 'served (200 or 503)': (r) => r.status === 200 || r.status === 503 });
}
