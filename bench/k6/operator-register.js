// Phase 12A A5 — k6 load for POST /api/operator/register.
// Write path (new operator row + identity/ownership links). Each request
// uses a fresh random 64-hex operator_id so we exercise the insert path
// rather than conflict-handling. 2 paliers (1x, 100x) per A5 scope.
//
// The controller's register handler also triggers verification side effects
// (NIP-05 / DNS TXT / LN pubkey) for `identities`. We pass an EMPTY
// identities array so we measure the DB-write path alone, not the
// external-I/O dependency.
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const RPS = Number(__ENV.RPS || 1);
const DURATION = __ENV.DURATION || '3m';
const WARMUP = __ENV.WARMUP || '30s';

const latency = new Trend('satrank_bench_operator_register_latency_ms', true);
const ok = new Rate('satrank_bench_operator_register_ok');

export const options = {
  discardResponseBodies: true,
  scenarios: {
    operator_register: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: Math.max(50, RPS * 2),
      maxVUs: Math.max(100, RPS * 4),
      stages: [
        { duration: WARMUP, target: RPS },
        { duration: DURATION, target: RPS },
      ],
      tags: { endpoint: 'operator_register' },
    },
  },
  thresholds: {
    'satrank_bench_operator_register_ok': ['rate>0.90'],
    'satrank_bench_operator_register_latency_ms': ['p(95)<800'],
  },
};

// 64-hex random id per iteration. The controller accepts it even if the hash
// isn't a real SHA-256 (schema is .length(64) of [a-f0-9]).
function randHex(n) {
  const chars = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < n; i++) s += chars.charAt(Math.floor(Math.random() * 16));
  return s;
}

const headers = { 'Content-Type': 'application/json' };

export default function () {
  const body = JSON.stringify({ operator_id: randHex(64), identities: [], ownerships: [] });
  const res = http.post(`${BASE_URL}/api/operator/register`, body, { headers });
  latency.add(res.timings.duration);
  // 201 Created (happy path), 409 Conflict (rare hash collision), 400
  // VALIDATION_ERROR if zod rejects the body.
  ok.add(res.status === 201 || res.status === 200);
  check(res, { 'status 2xx': (r) => r.status >= 200 && r.status < 300 });
}
