-- Phase 12A A4 — wrk script for GET /api/agent/:hash/verdict.
-- Paired with bench/k6/verdict.js. Reads the same fixture file for realistic
-- cache-hit distribution (~100 distinct hashes warmed uniformly at random).
--
-- Invocation (from staging host, from the repo root so the relative path
-- to the fixture resolves):
--   wrk -t4 -c100 -d10m -s bench/wrk/verdict.lua http://localhost:8080
--
-- If the fixture is missing we fall back to a single zero-hash.

local fixture_path = os.getenv("FIXTURE_PATH") or "bench/k6/fixtures/agents.json"

local hashes = {}
local function load_hashes()
  local f = io.open(fixture_path, "r")
  if not f then
    hashes = { "0000000000000000000000000000000000000000000000000000000000000000" }
    return
  end
  local raw = f:read("*a")
  f:close()
  -- Minimal JSON array parser: expect a flat array of quoted strings.
  -- Avoids pulling in a JSON library so the script runs on a vanilla wrk.
  for s in raw:gmatch('"([0-9a-fA-F]+)"') do
    table.insert(hashes, s)
  end
  if #hashes == 0 then
    hashes = { "0000000000000000000000000000000000000000000000000000000000000000" }
  end
end

load_hashes()
math.randomseed(os.time())

wrk.method = "GET"
wrk.headers["User-Agent"] = "satrank-bench-wrk/verdict"

function request()
  local h = hashes[math.random(#hashes)]
  return wrk.format(nil, "/api/agent/" .. h .. "/verdict")
end

function done(summary, latency, requests)
  io.write(string.format("[verdict] requests=%d duration=%.2fs rps=%.2f p50=%.2fms p95=%.2fms p99=%.2fms errors=%d pool=%d\n",
    summary.requests,
    summary.duration / 1e6,
    summary.requests / (summary.duration / 1e6),
    latency:percentile(50) / 1000,
    latency:percentile(95) / 1000,
    latency:percentile(99) / 1000,
    summary.errors.connect + summary.errors.read + summary.errors.write + summary.errors.status + summary.errors.timeout,
    #hashes
  ))
end
