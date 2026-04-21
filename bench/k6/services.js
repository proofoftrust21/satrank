// Phase 12A A4 — k6 load for GET /api/services.
// Representative of the service registry list-read path. Same rate class as
// /api/intent (discovery). Hits service_endpoints + cached scoring — lighter
// than /agents/top but shares the cache warm cost.
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const RPS = Number(__ENV.RPS || 10);
const DURATION = __ENV.DURATION || '10m';
const WARMUP = __ENV.WARMUP || '5m';
const LIMIT = Number(__ENV.LIMIT || 20);

const servicesLatency = new Trend('satrank_bench_services_latency_ms', true);
const servicesOk = new Rate('satrank_bench_services_ok');

export const options = {
  discardResponseBodies: true,
  scenarios: {
    services: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: Math.max(50, RPS * 2),
      maxVUs: Math.max(100, RPS * 4),
      stages: [
        { duration: WARMUP, target: RPS },
        { duration: DURATION, target: RPS },
      ],
      tags: { endpoint: 'services' },
    },
  },
  thresholds: {
    'satrank_bench_services_ok': ['rate>0.98'],
    'satrank_bench_services_latency_ms': ['p(95)<300'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/api/services?limit=${LIMIT}`);
  servicesLatency.add(res.timings.duration);
  servicesOk.add(res.status === 200);
  check(res, { 'status is 200': (r) => r.status === 200 });
}
