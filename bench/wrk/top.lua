-- Phase 12A A4 — wrk script for GET /api/agents/top?limit=50.
-- Paired with bench/k6/top.js. wrk hits the same canonical path (no 301).
--
-- Invocation (from staging host):
--   wrk -t4 -c100 -d10m -s bench/wrk/top.lua http://localhost:8080

wrk.method = "GET"
wrk.headers["User-Agent"] = "satrank-bench-wrk/top"

local path = "/api/agents/top?limit=50"

function request()
  return wrk.format(nil, path)
end

function done(summary, latency, requests)
  io.write(string.format("[top] requests=%d duration=%.2fs rps=%.2f p50=%.2fms p95=%.2fms p99=%.2fms errors=%d\n",
    summary.requests,
    summary.duration / 1e6,
    summary.requests / (summary.duration / 1e6),
    latency:percentile(50) / 1000,
    latency:percentile(95) / 1000,
    latency:percentile(99) / 1000,
    summary.errors.connect + summary.errors.read + summary.errors.write + summary.errors.status + summary.errors.timeout
  ))
end
