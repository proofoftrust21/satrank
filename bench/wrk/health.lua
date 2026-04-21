-- Phase 12A A4 — wrk script for GET /api/health.
-- wrk gives us a cross-check against k6: the two tools stress differently
-- (wrk is event-driven C, k6 is goroutines) and divergence in p95 under the
-- same target RPS reveals artefacts in one or the other.
--
-- Invocation (from staging host):
--   wrk -t4 -c100 -d10m -s bench/wrk/health.lua http://localhost:8080
--
-- We intentionally do NOT use the 'rate' limiter here — wrk drives to its
-- throughput ceiling, which is complementary to k6's ramping-arrival-rate.

wrk.method = "GET"
wrk.headers["User-Agent"] = "satrank-bench-wrk/health"

function request()
  return wrk.format(nil, "/api/health")
end

function done(summary, latency, requests)
  io.write(string.format("[health] requests=%d duration=%.2fs rps=%.2f p50=%.2fms p95=%.2fms p99=%.2fms errors=%d\n",
    summary.requests,
    summary.duration / 1e6,
    summary.requests / (summary.duration / 1e6),
    latency:percentile(50) / 1000,
    latency:percentile(95) / 1000,
    latency:percentile(99) / 1000,
    summary.errors.connect + summary.errors.read + summary.errors.write + summary.errors.status + summary.errors.timeout
  ))
end
