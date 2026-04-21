#!/usr/bin/env bash
# Phase 12A A6 — prod smoke, iso-charge calibration against A5 staging.
#
# Budget (hard caps):
#   - 500 GET requests on free endpoints (/api/health, /api/agents/top,
#     /api/services, /api/intent)
#   - 50 POST /api/probe (5 credits/call → 250 sats)
#   - ≤ 5000 sats total spend (we budget ≤ 1000 sats with 4x safety)
#
# Design :
# - No k6 on prod : we want deterministic request counts with a real cap,
#   not an arrival-rate scheduler that can overshoot on transient hiccups.
#   A small bash loop with `curl` + `xargs -P` is enough at ≤ 500 requests.
# - Free GETs are interleaved, 2 rps wall-clock rate. 500 requests ≈ 4 min.
# - Probes are emitted separately (authenticated) after the GET pass.
# - Output : bench/prod/results/<run-id>/*.csv + a summary.json.
#
# Required env :
#   SATRANK_API_KEY     — prod admin key (SAtRank ops only). Fallback : the
#                         L402 token path via deposit (see --use-deposit).
#   PHASE_12A_PROD_SMOKE_OK=yes  — kill switch: refuses to run without it.
#
# Safety :
# - REFUSED if PHASE_12A_PROD_SMOKE_OK != yes.
# - REFUSED if BASE_URL does NOT contain "satrank.dev" or the prod IP.
#   This script is explicitly prod-only; staging uses run-all.sh.
set -euo pipefail

BASE_URL="${BASE_URL:-https://satrank.dev}"
MAX_GET="${MAX_GET:-500}"
MAX_PROBE="${MAX_PROBE:-50}"
GET_RPS="${GET_RPS:-2}"
RUN_ID="${RUN_ID:-phase-12a-prod-$(date -u +%Y%m%d-%H%M)}"

if [[ "${PHASE_12A_PROD_SMOKE_OK:-no}" != "yes" ]]; then
  echo "REFUSED: set PHASE_12A_PROD_SMOKE_OK=yes to run the prod smoke." >&2
  echo "This script hits prod — it will show up in dashboards and (for /api/probe)" >&2
  echo "cost ≤ 1000 sats. Re-run once Romain has authorised the window." >&2
  exit 1
fi

case "${BASE_URL}" in
  *satrank.dev*|*178.104.108*) ;;
  *)
    echo "REFUSED: BASE_URL=${BASE_URL} does not look like prod. This script is prod-only; use bench/run-all.sh for staging." >&2
    exit 1
    ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${HERE}/results/${RUN_ID}"
mkdir -p "${OUT_DIR}"

endpoints=(
  "/api/health"
  "/api/agents/top?limit=50"
  "/api/services?limit=20"
)
# /api/intent — POST, same rate class. We intersperse it with the GETs.
intent_bodies=('{"category":"data","limit":5}' '{"category":"tools","limit":5}' '{"category":"bitcoin","limit":5}')

echo "Run ID : ${RUN_ID}"
echo "Base   : ${BASE_URL}"
echo "Budget : GET=${MAX_GET} probe=${MAX_PROBE}"
echo

# ------------------------------------------------------------------
# PASS 1 — free GETs (no auth) + /api/intent (POST, discoveryRateLimit)
# ------------------------------------------------------------------
get_csv="${OUT_DIR}/gets.csv"
echo "timestamp,endpoint,http_code,total_time_ms" > "${get_csv}"
sleep_sec=$(awk -v r="${GET_RPS}" 'BEGIN{printf "%.3f", 1/r}')

i=0
total=$((MAX_GET))
while (( i < total )); do
  # rotation: 3 free GETs, 1 POST /api/intent → 25 % of traffic is POST
  case $(( i % 4 )) in
    0|1|2)
      ep="${endpoints[$(( (i/3) % ${#endpoints[@]} ))]}"
      t=$(curl -s -o /dev/null -w '%{time_total}' -m 10 "${BASE_URL}${ep}" || echo "0")
      code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "${BASE_URL}${ep}" || echo "000")
      ms=$(awk -v t="${t}" 'BEGIN{printf "%.1f", t*1000}')
      echo "$(date -u +%H:%M:%S.%3N),${ep},${code},${ms}" >> "${get_csv}"
      ;;
    3)
      body="${intent_bodies[$(( (i/4) % ${#intent_bodies[@]} ))]}"
      t=$(curl -s -o /dev/null -w '%{time_total}' -m 10 -X POST \
            -H 'content-type: application/json' -d "${body}" \
            "${BASE_URL}/api/intent" || echo "0")
      code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST \
            -H 'content-type: application/json' -d "${body}" \
            "${BASE_URL}/api/intent" || echo "000")
      ms=$(awk -v t="${t}" 'BEGIN{printf "%.1f", t*1000}')
      echo "$(date -u +%H:%M:%S.%3N),/api/intent,${code},${ms}" >> "${get_csv}"
      ;;
  esac
  i=$(( i + 1 ))
  sleep "${sleep_sec}"
done

echo "GET pass done : ${MAX_GET} requests → ${get_csv}"

# ------------------------------------------------------------------
# PASS 2 — /api/probe (paid, 5 credits/call)
# ------------------------------------------------------------------
if [[ -z "${SATRANK_API_KEY:-}" ]]; then
  echo "NOTE: SATRANK_API_KEY not set — skipping probe pass." >&2
  echo "To include the probe pass, export SATRANK_API_KEY or pay an L402 token first." >&2
else
  probe_csv="${OUT_DIR}/probes.csv"
  echo "timestamp,target,http_code,total_time_ms" > "${probe_csv}"
  # Sample targets from the top-50 to guarantee valid hashes. Use the same
  # fixture we use in bench/k6/verdict.js for cross-bench comparability.
  targets=( $(jq -r '.[]' "${HERE}/../k6/fixtures/agents.json" | head -n "${MAX_PROBE}") )
  for t in "${targets[@]}"; do
    body=$(printf '{"target":"%s","probeType":"liquidity"}' "${t}")
    start=$(date -u +%s.%N)
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 -X POST \
      -H "X-API-Key: ${SATRANK_API_KEY}" \
      -H 'content-type: application/json' \
      -d "${body}" \
      "${BASE_URL}/api/probe" || echo "000")
    end=$(date -u +%s.%N)
    ms=$(awk -v s="${start}" -v e="${end}" 'BEGIN{printf "%.1f", (e-s)*1000}')
    echo "$(date -u +%H:%M:%S.%3N),${t},${code},${ms}" >> "${probe_csv}"
    sleep 1
  done
  echo "PROBE pass done : ${MAX_PROBE} requests → ${probe_csv}"
fi

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
summary="${OUT_DIR}/summary.json"
python3 - "${OUT_DIR}" <<'PY' > "${summary}"
import csv, json, os, statistics, sys
root = sys.argv[1]
out = {"run_id": os.path.basename(root), "passes": {}}
for name in ("gets", "probes"):
    path = os.path.join(root, f"{name}.csv")
    if not os.path.exists(path):
        continue
    rows = list(csv.DictReader(open(path)))
    lat = [float(r["total_time_ms"]) for r in rows if r["total_time_ms"]]
    codes = {}
    for r in rows:
        codes[r["http_code"]] = codes.get(r["http_code"], 0) + 1
    out["passes"][name] = {
        "requests": len(rows),
        "status_codes": codes,
        "p50_ms": statistics.median(lat) if lat else 0,
        "p95_ms": (sorted(lat)[int(0.95 * len(lat))] if len(lat) >= 20 else max(lat) if lat else 0),
        "p99_ms": (sorted(lat)[int(0.99 * len(lat))] if len(lat) >= 100 else max(lat) if lat else 0),
        "avg_ms": statistics.fmean(lat) if lat else 0,
    }
print(json.dumps(out, indent=2))
PY

echo
echo "Summary : ${summary}"
cat "${summary}"
