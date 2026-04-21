#!/usr/bin/env bash
# Phase 12A A5 — orchestrator for the paliers sweep on staging.
# Runs the A4 k6 scripts across 4 load paliers (1x → 10x → 100x → 1000x) for
# each endpoint. Output is written under bench/results/<run-id>/ as JSON +
# summary txt so A7 can aggregate without re-running.
#
# Usage (from staging host, repo root = /opt/satrank-staging):
#   ./bench/run-all.sh                    # full sweep on localhost:8080
#   BASE_URL=http://x RPS_SET=10,50 ...   # override paliers
#   ENDPOINTS=health,top ./bench/run-all.sh   # restrict to a subset
#
# Environment:
#   BASE_URL     default http://localhost:8080
#   ENDPOINTS    comma-list of {health,top,verdict,intent,services} (default: all)
#   RPS_SET      comma-list of RPS targets (default: 1,10,100,1000)
#   WARMUP       k6 warmup duration per palier (default: 5m)
#   DURATION     k6 sustained duration per palier (default: 10m)
#   REST         sleep between paliers to let the cache drain (default: 2m)
#   RUN_ID       override run identifier (default: phase-12a-YYYYMMDD-HHMM)
#   DRY_RUN=1    print the plan and exit without hitting the api
#
# Safety:
# - The 1000x palier is hard-gated behind SATRANK_BENCH_1000X=yes. A typo in
#   RPS_SET won't accidentally drive 1000 rps into prod-sized infra.
# - BASE_URL containing "satrank.dev" or "178.104.108" (prod) is refused. This
#   orchestrator is a staging-only tool; A6 prod smoke is a separate script.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
ENDPOINTS="${ENDPOINTS:-health,top,verdict,intent,services}"
RPS_SET="${RPS_SET:-1,10,100,1000}"
WARMUP="${WARMUP:-5m}"
DURATION="${DURATION:-10m}"
REST="${REST:-2m}"
RUN_ID="${RUN_ID:-phase-12a-$(date -u +%Y%m%d-%H%M)}"

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/.." && pwd)"
OUT_DIR="${REPO}/bench/results/${RUN_ID}"
mkdir -p "${OUT_DIR}"

# Prod guard — staging only
if [[ "${BASE_URL}" == *"satrank.dev"* || "${BASE_URL}" == *"178.104.108"* ]]; then
  echo "REFUSED: BASE_URL looks like prod (${BASE_URL}). This orchestrator is staging-only." >&2
  echo "For the prod smoke see bench/run-prod-smoke.sh (A6, requires separate authorisation)." >&2
  exit 1
fi

# 1000x gate
if [[ ",${RPS_SET}," == *",1000,"* && "${SATRANK_BENCH_1000X:-no}" != "yes" ]]; then
  echo "REFUSED: RPS_SET includes 1000 but SATRANK_BENCH_1000X != yes." >&2
  echo "Re-run with SATRANK_BENCH_1000X=yes to acknowledge the palier." >&2
  exit 1
fi

# Associative arrays require bash 4+. We use a case statement so the script
# also runs on macOS bash 3.2 for local dry-run.
script_for() {
  case "$1" in
    health)   echo "bench/k6/health.js" ;;
    top)      echo "bench/k6/top.js" ;;
    verdict)  echo "bench/k6/verdict.js" ;;
    intent)   echo "bench/k6/intent.js" ;;
    services) echo "bench/k6/services.js" ;;
    *)        echo "" ;;
  esac
}

run_one() {
  local endpoint="$1"
  local rps="$2"
  local script
  script="$(script_for "${endpoint}")"
  if [[ -z "${script}" ]]; then
    echo "SKIP: unknown endpoint '${endpoint}'" >&2
    return
  fi
  local tag="${endpoint}_rps${rps}"
  local json="${OUT_DIR}/${tag}.json"
  local summary="${OUT_DIR}/${tag}.summary.txt"

  echo "=== [$(date -u +%H:%M:%S)] ${endpoint} @ ${rps} rps (warmup=${WARMUP} sustained=${DURATION}) ==="
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    echo "    DRY_RUN: would run k6 run --summary-export=${json} ${script}"
    return
  fi

  BASE_URL="${BASE_URL}" RPS="${rps}" DURATION="${DURATION}" WARMUP="${WARMUP}" \
    k6 run --quiet --summary-export="${json}" "${REPO}/${script}" \
    > "${summary}" 2>&1 || {
      echo "    WARN: k6 exited non-zero for ${tag} (threshold breach or error) — keeping output" >&2
    }
  echo "    wrote ${json} + ${summary}"
}

IFS=',' read -ra EP_ARR <<< "${ENDPOINTS}"
IFS=',' read -ra RPS_ARR <<< "${RPS_SET}"

echo "Run ID: ${RUN_ID}"
echo "Out:    ${OUT_DIR}"
echo "Base:   ${BASE_URL}"
echo "Plan:   endpoints=${ENDPOINTS} paliers=${RPS_SET}"
echo

for endpoint in "${EP_ARR[@]}"; do
  if [[ -z "$(script_for "${endpoint}")" ]]; then
    echo "SKIP: unknown endpoint '${endpoint}' (known: health,top,verdict,intent,services)" >&2
    continue
  fi
  for rps in "${RPS_ARR[@]}"; do
    run_one "${endpoint}" "${rps}"
    if [[ "${DRY_RUN:-0}" != "1" ]]; then
      echo "    rest ${REST}"
      # GNU sleep accepts suffixed durations (30s, 2m, 1h). Fallback to a raw
      # integer + "s" if the suffixed form is rejected (e.g. BusyBox sleep).
      sleep "${REST}" 2>/dev/null || sleep 120
    fi
  done
done

echo
echo "All paliers done — results in ${OUT_DIR}"
echo "Aggregate with: bench/aggregate.py ${OUT_DIR}"
