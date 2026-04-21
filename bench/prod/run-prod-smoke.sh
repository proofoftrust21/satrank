#!/usr/bin/env bash
# Phase 12A A6 — prod smoke, iso-charge calibration against A5 staging.
#
# Budget (hard caps) — reduced per Romain's 2026-04-21 GO message:
#   - 500 requests total, interleaved /api/agents/top (GET, 75 %) and
#     /api/intent (POST, 25 %). That is the exact scope authorised.
#   - Probe pass SKIPPED. Rationale : already measured extensively on
#     staging (A5 paliers), prod has 0 users so probe traffic is
#     artificial on the single public instance, 5000-sat budget better
#     spent on Phase 13B E2E agent flows, staging-vs-prod delta on
#     probe doesn't influence the 12B bottleneck priorities.
#   - Total cost : 0 sats.
#
# Design :
# - No k6 on prod : we want deterministic request counts with a real cap,
#   not an arrival-rate scheduler that can overshoot on transient hiccups.
#   A small bash loop with a single `curl` per measurement is enough at
#   ≤ 500 requests. (The earlier version double-curled — one for
#   `%{http_code}`, one for `%{time_total}` — effectively doubling the
#   load. Fixed : single curl with multi-field `-w`.)
# - Requests at 2 rps wall-clock. 500 requests ≈ 4 min 10 s.
# - Output : bench/prod/results/<run-id>/*.csv + a summary.json.
#
# Required env :
#   PHASE_12A_PROD_SMOKE_OK=yes  — kill switch: refuses to run without it.
#
# Safety :
# - REFUSED if PHASE_12A_PROD_SMOKE_OK != yes.
# - REFUSED if BASE_URL does NOT contain "satrank.dev" or the prod IP.
#   This script is explicitly prod-only; staging uses run-all.sh.
set -euo pipefail

BASE_URL="${BASE_URL:-https://satrank.dev}"
MAX_GET="${MAX_GET:-500}"
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

# Restricted scope (Romain 2026-04-21) : only /api/agents/top + /api/intent.
top_endpoint="/api/agents/top?limit=50"
intent_bodies=('{"category":"data","limit":5}' '{"category":"tools","limit":5}' '{"category":"bitcoin","limit":5}')

echo "Run ID : ${RUN_ID}"
echo "Base   : ${BASE_URL}"
echo "Scope  : /api/agents/top (75 %) + /api/intent (25 %), total ${MAX_GET}"
echo "Cost   : 0 sats (probe pass skipped per GO message)"
echo

# ------------------------------------------------------------------
# PASS 1 — /api/agents/top (GET, 75 %) + /api/intent (POST, 25 %)
# Single curl per measurement (http_code + time_total in one call).
# ------------------------------------------------------------------
csv_path="${OUT_DIR}/requests.csv"
echo "timestamp,endpoint,http_code,total_time_ms" > "${csv_path}"
sleep_sec=$(awk -v r="${GET_RPS}" 'BEGIN{printf "%.3f", 1/r}')

i=0
total=$((MAX_GET))
while (( i < total )); do
  # Rotation : 3 GETs on /api/agents/top, then 1 POST on /api/intent.
  case $(( i % 4 )) in
    0|1|2)
      ep="${top_endpoint}"
      out=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' -m 10 "${BASE_URL}${ep}" 2>/dev/null || echo "000 0")
      code=$(echo "${out}" | awk '{print $1}')
      t=$(echo "${out}" | awk '{print $2}')
      ms=$(awk -v t="${t}" 'BEGIN{printf "%.1f", t*1000}')
      echo "$(date -u +%H:%M:%S.%3N),${ep},${code},${ms}" >> "${csv_path}"
      ;;
    3)
      body="${intent_bodies[$(( (i/4) % ${#intent_bodies[@]} ))]}"
      out=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' -m 10 -X POST \
            -H 'content-type: application/json' -d "${body}" \
            "${BASE_URL}/api/intent" 2>/dev/null || echo "000 0")
      code=$(echo "${out}" | awk '{print $1}')
      t=$(echo "${out}" | awk '{print $2}')
      ms=$(awk -v t="${t}" 'BEGIN{printf "%.1f", t*1000}')
      echo "$(date -u +%H:%M:%S.%3N),/api/intent,${code},${ms}" >> "${csv_path}"
      ;;
  esac
  i=$(( i + 1 ))
  sleep "${sleep_sec}"
done

echo "Request pass done : ${MAX_GET} requests → ${csv_path}"

# ------------------------------------------------------------------
# Summary — per-endpoint rollup.
# ------------------------------------------------------------------
summary="${OUT_DIR}/summary.json"
python3 - "${OUT_DIR}" <<'PY' > "${summary}"
import csv, json, os, statistics, sys
from collections import defaultdict
root = sys.argv[1]
path = os.path.join(root, "requests.csv")
rows = list(csv.DictReader(open(path)))
by_ep = defaultdict(list)
codes_by_ep = defaultdict(lambda: defaultdict(int))
for r in rows:
    by_ep[r["endpoint"]].append(float(r["total_time_ms"]))
    codes_by_ep[r["endpoint"]][r["http_code"]] += 1

def pct(lst, q):
    if not lst:
        return 0.0
    s = sorted(lst)
    k = int(q * (len(s) - 1))
    return s[k]

out = {"run_id": os.path.basename(root), "endpoints": {}}
for ep, lat in by_ep.items():
    out["endpoints"][ep] = {
        "requests": len(lat),
        "status_codes": dict(codes_by_ep[ep]),
        "p50_ms": round(pct(lat, 0.50), 1),
        "p90_ms": round(pct(lat, 0.90), 1),
        "p95_ms": round(pct(lat, 0.95), 1),
        "p99_ms": round(pct(lat, 0.99), 1),
        "max_ms": round(max(lat), 1) if lat else 0.0,
        "avg_ms": round(statistics.fmean(lat), 1) if lat else 0.0,
    }
print(json.dumps(out, indent=2))
PY

echo
echo "Summary : ${summary}"
cat "${summary}"
