// Phase 12A A5 — k6 load for GET /api/operator/:id.
// Operator lookup — similar shape to /api/agent/:hash/verdict, measured at
// two paliers (10x and 1000x) per the A5 scope reduction (redundant lookup
// endpoint).
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Trend, Rate, Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const RPS = Number(__ENV.RPS || 10);
const DURATION = __ENV.DURATION || '3m';
const WARMUP = __ENV.WARMUP || '30s';
const FIXTURE_PATH = __ENV.FIXTURE_PATH || './fixtures/operators.json';

const operators = new SharedArray('operators', () => {
  try {
    const raw = open(FIXTURE_PATH);
    return JSON.parse(raw);
  } catch (_err) {
    return ['a2be9a8b5552625831f9cef42a3404a8570db14fe9556a3b54d26a201be2caae'];
  }
});

const latency = new Trend('satrank_bench_operator_show_latency_ms', true);
const ok = new Rate('satrank_bench_operator_show_ok');
const notFound = new Counter('satrank_bench_operator_show_not_found');

export const options = {
  discardResponseBodies: true,
  scenarios: {
    operator_show: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: Math.max(100, RPS * 2),
      maxVUs: Math.max(200, RPS * 4),
      stages: [
        { duration: WARMUP, target: RPS },
        { duration: DURATION, target: RPS },
      ],
      tags: { endpoint: 'operator_show' },
    },
  },
  thresholds: {
    'satrank_bench_operator_show_ok': ['rate>0.95'],
    'satrank_bench_operator_show_latency_ms': ['p(95)<500'],
  },
};

export default function () {
  const id = operators[Math.floor(Math.random() * operators.length)];
  const res = http.get(`${BASE_URL}/api/operator/${id}`);
  latency.add(res.timings.duration);
  ok.add(res.status === 200);
  if (res.status === 404) notFound.add(1);
  check(res, { 'status 200 or 404': (r) => r.status === 200 || r.status === 404 });
}
