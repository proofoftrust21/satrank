// Phase 12A A4 — k6 load for POST /api/intent.
// Phase 10 deprecated /api/decide in favour of /api/intent (neutral discovery,
// no positional pathfinding). This script exercises the replacement hot path.
// p95 under cache is the target; cold p95 dominated by service_endpoints scan.
//
// The category pool is sampled from the live /api/intent/categories response
// at bench-setup time and materialised in bench/k6/fixtures/categories.json.
// If the fixture is absent the script falls back to a small hard-coded list
// that is known to exist in the cloned prod DB.
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Trend, Rate, Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const RPS = Number(__ENV.RPS || 10);
const DURATION = __ENV.DURATION || '10m';
const WARMUP = __ENV.WARMUP || '5m';
const FIXTURE_PATH = __ENV.FIXTURE_PATH || './fixtures/categories.json';

const categories = new SharedArray('categories', () => {
  try {
    const raw = open(FIXTURE_PATH);
    return JSON.parse(raw);
  } catch (_err) {
    // Fallback : categories known to exist in the cloned prod DB (A0)
    return ['data', 'tools', 'ai', 'bitcoin', 'ai/text'];
  }
});

const intentLatency = new Trend('satrank_bench_intent_latency_ms', true);
const intentOk = new Rate('satrank_bench_intent_ok');
const intentInvalidCategory = new Counter('satrank_bench_intent_invalid_category');

export const options = {
  discardResponseBodies: true,
  scenarios: {
    intent: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: Math.max(100, RPS * 2),
      maxVUs: Math.max(200, RPS * 4),
      stages: [
        { duration: WARMUP, target: RPS },
        { duration: DURATION, target: RPS },
      ],
      tags: { endpoint: 'intent' },
    },
  },
  thresholds: {
    'satrank_bench_intent_ok': ['rate>0.95'],
    'satrank_bench_intent_latency_ms': ['p(95)<500'],
  },
};

const headers = { 'Content-Type': 'application/json' };

export default function () {
  const category = categories[Math.floor(Math.random() * categories.length)];
  const body = JSON.stringify({ category, limit: 5 });
  const res = http.post(`${BASE_URL}/api/intent`, body, { headers });
  intentLatency.add(res.timings.duration);
  intentOk.add(res.status === 200);
  if (res.status === 400) intentInvalidCategory.add(1);
  // 400 is acceptable when a rare category has no trusted mapping; 200 is the
  // happy path. We keep the check forgiving so threshold violations flag only
  // genuine regressions (5xx, timeouts).
  check(res, { 'status 200 or 400': (r) => r.status === 200 || r.status === 400 });
}
