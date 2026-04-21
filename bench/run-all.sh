#!/usr/bin/env bash
# Phase 12A A5 — orchestrator for the paliers sweep on staging.
# Each palier : k6 ramping-arrival-rate, 30s warmup → N-min sustained,
# summary exported to bench/results/<run-id>/<endpoint>_rps<N>.json.
#
# Between paliers : a short rest + a /api/health probe. If the probe
# fails (connection refused / non-2xx/503), remaining paliers for the
# same endpoint are SKIPPED and flagged "api_down" in a plan.log next
# to the results. This catches the "container died under load" case
# cleanly without monitoring k6 in-flight.
#
# Per-endpoint palier matrices (see PLAN below) : redundant lookup
# endpoints bench only at two paliers, write paths only at two paliers,
# heavy read paths keep all four. Matches the 2026-04-21 scope reduction.
#
# Usage (from /opt/satrank-staging on the staging VM) :
#   ./bench/run-all.sh                   # full compressed sweep
#   DRY_RUN=1 ./bench/run-all.sh         # print the plan, no k6
#   RUN_ID=custom ./bench/run-all.sh
#
# Env overrides :
#   BASE_URL       default http://localhost:8080
#   WARMUP         default 30s
#   DURATION       default 3m
#   REST           default 30s
#   SATRANK_BENCH_1000X=yes   required if any palier contains 1000+
#   DRY_RUN=1      print plan + exit
#
# Safety :
# - REFUSED if BASE_URL looks like prod (satrank.dev / 178.104.108).
# - REFUSED if PLAN contains 1000 RPS and SATRANK_BENCH_1000X != yes.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
WARMUP="${WARMUP:-30s}"
DURATION="${DURATION:-3m}"
REST="${REST:-30s}"
RUN_ID="${RUN_ID:-phase-12a-$(date -u +%Y%m%d-%H%M)}"

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/.." && pwd)"
OUT_DIR="${REPO}/bench/results/${RUN_ID}"
PLAN_LOG="${OUT_DIR}/plan.log"
mkdir -p "${OUT_DIR}"

# Prod guard
case "${BASE_URL}" in
  *satrank.dev*|*178.104.108*)
    echo "REFUSED: BASE_URL=${BASE_URL} looks like prod. Staging-only." >&2
    exit 1 ;;
esac

# PLAN : one line per palier. Format "endpoint rps".
# health was already run before the scope reduction — keeping the data,
# not re-running.
DEFAULT_PLAN='
top 1
top 10
top 100
top 1000
verdict 10
verdict 1000
intent 1
intent 10
intent 100
intent 1000
services 10
services 1000
operator_show 10
operator_show 1000
'

PLAN="${PLAN:-${DEFAULT_PLAN}}"

# 1000x gate : reject the plan if any 1000-rps line is present without ack
if echo "${PLAN}" | awk 'NR>0{ if ($2 == 1000 || $2 == 2000 || $2 == 5000) exit 1 }'; then
  :
else
  if [[ "${SATRANK_BENCH_1000X:-no}" != "yes" ]]; then
    echo "REFUSED: plan contains 1000 RPS but SATRANK_BENCH_1000X != yes." >&2
    exit 1
  fi
fi

# Associative paths via case → portable on bash 3.2 (local dry-run on macOS).
script_for() {
  case "$1" in
    health)             echo "bench/k6/health.js" ;;
    top)                echo "bench/k6/top.js" ;;
    verdict)            echo "bench/k6/verdict.js" ;;
    intent)             echo "bench/k6/intent.js" ;;
    services)           echo "bench/k6/services.js" ;;
    operator_show)      echo "bench/k6/operator-show.js" ;;
    operator_register)  echo "bench/k6/operator-register.js" ;;
    *)                  echo "" ;;
  esac
}

echo "Run ID : ${RUN_ID}"
echo "Out    : ${OUT_DIR}"
echo "Base   : ${BASE_URL}"
echo "Params : warmup=${WARMUP} duration=${DURATION} rest=${REST}"
echo "Plan :"
echo "${PLAN}" | sed 's/^/    /'
echo

# Probe helper : 1 if /api/health returns 200 or 503 (server is serving),
# 0 if connection refused or 4xx other than 5xx. Timeout 5s.
api_is_up() {
  local code
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "${BASE_URL}/api/health" || echo 000)
  if [[ "${code}" == "200" || "${code}" == "503" ]]; then
    return 0
  fi
  return 1
}

run_one() {
  local endpoint="$1"
  local rps="$2"
  local script
  script="$(script_for "${endpoint}")"
  if [[ -z "${script}" ]]; then
    echo "SKIP [no-script]: endpoint '${endpoint}'" | tee -a "${PLAN_LOG}" >&2
    return
  fi

  local tag="${endpoint}_rps${rps}"
  local json="${OUT_DIR}/${tag}.json"
  local summary="${OUT_DIR}/${tag}.summary.txt"

  echo "=== [$(date -u +%H:%M:%S)] ${endpoint} @ ${rps} rps (warmup=${WARMUP} sustained=${DURATION}) ===" | tee -a "${PLAN_LOG}"
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    echo "    DRY_RUN: k6 run --summary-export=${json} ${script}" | tee -a "${PLAN_LOG}"
    return
  fi

  BASE_URL="${BASE_URL}" RPS="${rps}" DURATION="${DURATION}" WARMUP="${WARMUP}" \
    k6 run --quiet --summary-export="${json}" "${REPO}/${script}" \
    > "${summary}" 2>&1 || {
      echo "    WARN: k6 exited non-zero for ${tag} (threshold breach / error)" | tee -a "${PLAN_LOG}" >&2
    }
  echo "    wrote ${tag}.json + ${tag}.summary.txt" | tee -a "${PLAN_LOG}"
}

# Skip set : once an endpoint's api is down, subsequent paliers for the
# same endpoint are flagged without running. Others may still run.
declare -a SKIP_ENDPOINTS=()
endpoint_is_skipped() {
  local ep="$1"
  local s
  for s in "${SKIP_ENDPOINTS[@]:-}"; do
    [[ "${s}" == "${ep}" ]] && return 0
  done
  return 1
}

# Iterate the plan
while IFS= read -r line; do
  # Skip blank lines and comments
  line="$(echo "${line}" | awk '{$1=$1; print}')"
  [[ -z "${line}" || "${line}" =~ ^# ]] && continue
  endpoint="$(echo "${line}" | awk '{print $1}')"
  rps="$(echo "${line}" | awk '{print $2}')"

  if endpoint_is_skipped "${endpoint}"; then
    echo "SKIP [api_down earlier in run]: ${endpoint} @ ${rps} rps" | tee -a "${PLAN_LOG}" >&2
    continue
  fi

  run_one "${endpoint}" "${rps}"

  # Inter-palier health probe. Aborts remaining paliers for THIS endpoint
  # if the api is down (cascade guard). Other endpoints still attempted.
  if [[ "${DRY_RUN:-0}" != "1" ]]; then
    if ! api_is_up; then
      echo "    WARN: /api/health unhealthy after ${endpoint}@${rps} — skipping remaining paliers for ${endpoint}" | tee -a "${PLAN_LOG}" >&2
      SKIP_ENDPOINTS+=( "${endpoint}" )
    fi
    echo "    rest ${REST}" | tee -a "${PLAN_LOG}"
    sleep "${REST}" 2>/dev/null || sleep 30
  fi
done <<< "${PLAN}"

echo | tee -a "${PLAN_LOG}"
echo "All planned paliers processed — results in ${OUT_DIR}" | tee -a "${PLAN_LOG}"
echo "Aggregate with : bench/aggregate.py ${OUT_DIR}" | tee -a "${PLAN_LOG}"
