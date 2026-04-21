// Phase 12A A4 — k6 load for GET /api/top.
// Representative of the heavy list-read path : DB scan by composite index +
// cached JSON result. Used from dashboards and first-contact clients.
// Target : p95 < 300 ms under cache; cold p95 dominated by stats cache warm.
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const RPS = Number(__ENV.RPS || 10);
const DURATION = __ENV.DURATION || '10m';
const WARMUP = __ENV.WARMUP || '5m';
const LIMIT = Number(__ENV.LIMIT || 50);

const topLatency = new Trend('satrank_bench_top_latency_ms', true);
const topOk = new Rate('satrank_bench_top_ok');

export const options = {
  discardResponseBodies: true,
  scenarios: {
    top: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: Math.max(50, RPS * 2),
      maxVUs: Math.max(100, RPS * 4),
      stages: [
        { duration: WARMUP, target: RPS },
        { duration: DURATION, target: RPS },
      ],
      tags: { endpoint: 'top' },
    },
  },
  thresholds: {
    'satrank_bench_top_ok': ['rate>0.98'],
    'satrank_bench_top_latency_ms': ['p(95)<300'],
  },
};

export default function () {
  // Canonical path — /api/top 301-redirects here; hitting the canonical path
  // avoids including the redirect hop in the latency budget.
  const res = http.get(`${BASE_URL}/api/agents/top?limit=${LIMIT}`);
  topLatency.add(res.timings.duration);
  topOk.add(res.status === 200);
  check(res, { 'status is 200': (r) => r.status === 200 });
}
