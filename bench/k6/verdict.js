// Phase 12A A4 — k6 load for GET /api/agent/:hash/verdict.
// Representative of the hot read path : DB read + cache check + Bayesian
// posterior compute + risk profile. Cache should absorb most of the cost
// past first-hit; p95 under cache is the target.
//
// The agent hashes pool is sampled from the cloned prod DB at deploy-staging-api
// time and materialised in bench/k6/fixtures/agents.json. If the fixture is
// absent the script falls back to a single known-valid hash — use the
// fixture for realistic cache-hit distribution.
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Trend, Rate, Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const RPS = Number(__ENV.RPS || 10);
const DURATION = __ENV.DURATION || '10m';
const WARMUP = __ENV.WARMUP || '5m';
const FIXTURE_PATH = __ENV.FIXTURE_PATH || './fixtures/agents.json';

// Load the agent-hash pool once per VU process
const agents = new SharedArray('agents', () => {
  try {
    const raw = open(FIXTURE_PATH);
    return JSON.parse(raw);
  } catch (_err) {
    // Fallback : one known-valid hash generated at A0 (SHA256 of LN pubkey)
    return ['0000000000000000000000000000000000000000000000000000000000000000'];
  }
});

const verdictLatency = new Trend('satrank_bench_verdict_latency_ms', true);
const verdictOk = new Rate('satrank_bench_verdict_ok');
const verdictNotFound = new Counter('satrank_bench_verdict_not_found');

export const options = {
  discardResponseBodies: true,
  scenarios: {
    verdict: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: Math.max(100, RPS * 2),
      maxVUs: Math.max(200, RPS * 4),
      stages: [
        { duration: WARMUP, target: RPS },
        { duration: DURATION, target: RPS },
      ],
      tags: { endpoint: 'verdict' },
    },
  },
  thresholds: {
    'satrank_bench_verdict_ok': ['rate>0.95'],
    'satrank_bench_verdict_latency_ms': ['p(95)<500'],
  },
};

export default function () {
  const hash = agents[Math.floor(Math.random() * agents.length)];
  const res = http.get(`${BASE_URL}/api/agent/${hash}/verdict`);
  verdictLatency.add(res.timings.duration);
  verdictOk.add(res.status === 200);
  if (res.status === 404) verdictNotFound.add(1);
  check(res, { 'status 200 or 404': (r) => r.status === 200 || r.status === 404 });
}
