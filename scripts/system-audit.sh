#!/bin/bash
# Exhaustive technical health audit for SatRank.
#
# Tests each shipped feature end-to-end: infrastructure, API endpoints,
# data flow (DB), cron schedules, Nostr presence, observability. Each
# check emits one PASS / FAIL / WARN line. Exit code = number of FAILs
# (0 = all green).
#
# Usage:
#   ./scripts/system-audit.sh                                  # against prod (https://satrank.dev)
#   API_BASE=https://example.com ./scripts/system-audit.sh     # custom base
#   SSH_HOST=root@ip ./scripts/system-audit.sh                 # custom VM1
#   ./scripts/system-audit.sh --no-ssh                         # skip VM1 checks (curl only)
#
# Notes:
#   - Requires curl, jq, ssh (unless --no-ssh).
#   - SSH-based checks need a key with root@VM1 access.

set -u

API_BASE="${API_BASE:-https://satrank.dev}"
SSH_HOST="${SSH_HOST:-root@178.104.108.108}"
EXPECTED_SCHEMA="${EXPECTED_SCHEMA:-56}"
SKIP_SSH=0

for arg in "$@"; do
  case "$arg" in
    --no-ssh) SKIP_SSH=1 ;;
    --help|-h)
      sed -n '2,15p' "$0" | sed 's/^# *//'
      exit 0
      ;;
  esac
done

# Color helpers (no-color when not a TTY)
if [ -t 1 ]; then
  GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[0;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; BLUE=''; NC=''
fi

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0
FAIL_LIST=()

pass() { printf "  ${GREEN}[PASS]${NC} %s\n" "$1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { printf "  ${RED}[FAIL]${NC} %s\n" "$1"; FAIL_COUNT=$((FAIL_COUNT + 1)); FAIL_LIST+=("$1"); }
warn() { printf "  ${YELLOW}[WARN]${NC} %s\n" "$1"; WARN_COUNT=$((WARN_COUNT + 1)); }
section() { printf "\n${BLUE}== %s ==${NC}\n" "$1"; }
detail() { printf "         ${NC}%s\n" "$1"; }

curl_get() { curl -fsS --max-time 10 "$@" 2>/dev/null; }
curl_get_with_status() { curl -sS --max-time 10 -w "\nHTTP_STATUS:%{http_code}" "$@" 2>/dev/null; }

# Pretty timestamp
START_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf "${BLUE}SatRank technical audit ${NC}— ${API_BASE} — ${START_TS}\n"
printf "ssh: %s\n" "$([ "$SKIP_SSH" -eq 0 ] && echo "$SSH_HOST" || echo 'SKIPPED (--no-ssh)')"

# ---------------------------------------------------------------------------
section "1. Infrastructure"
# ---------------------------------------------------------------------------
HEALTH_JSON=$(curl_get "$API_BASE/api/health" || echo '')
if [ -n "$HEALTH_JSON" ] && echo "$HEALTH_JSON" | jq -e '.data.status == "ok"' >/dev/null 2>&1; then
  pass "/api/health status=ok"
  SCHEMA=$(echo "$HEALTH_JSON" | jq -r '.data.schemaVersion')
  EXP_SCHEMA=$(echo "$HEALTH_JSON" | jq -r '.data.expectedSchemaVersion')
  if [ "$SCHEMA" = "$EXPECTED_SCHEMA" ] && [ "$EXP_SCHEMA" = "$EXPECTED_SCHEMA" ]; then
    pass "schema version $SCHEMA / $EXP_SCHEMA (expected $EXPECTED_SCHEMA)"
  else
    fail "schema drift: got $SCHEMA / $EXP_SCHEMA, expected $EXPECTED_SCHEMA"
  fi
  DB_STATUS=$(echo "$HEALTH_JSON" | jq -r '.data.dbStatus')
  [ "$DB_STATUS" = "ok" ] && pass "Postgres dbStatus=ok" || fail "Postgres dbStatus=$DB_STATUS"
  LND_STATUS=$(echo "$HEALTH_JSON" | jq -r '.data.lndStatus')
  [ "$LND_STATUS" = "ok" ] && pass "LND lndStatus=ok" || fail "LND lndStatus=$LND_STATUS"
  STALE=$(echo "$HEALTH_JSON" | jq -r '.data.scoringStale')
  [ "$STALE" = "false" ] && pass "scoring not stale" || warn "scoring stale (scoringAgeSec=$(echo "$HEALTH_JSON" | jq -r '.data.scoringAgeSec'))"
else
  fail "/api/health unreachable or status != ok"
fi

if [ "$SKIP_SSH" -eq 0 ]; then
  PS_OUT=$(ssh -o ConnectTimeout=5 "$SSH_HOST" 'docker ps --format "{{.Names}}\t{{.Status}}"' 2>/dev/null || echo '')
  for c in satrank-api satrank-crawler ptail-prod; do
    if echo "$PS_OUT" | grep -q "^$c"; then
      STATUS_LINE=$(echo "$PS_OUT" | grep "^$c" | head -1)
      if echo "$STATUS_LINE" | grep -qE "Up.*healthy|Up [0-9]+ (seconds|minutes|hours|days|weeks|months)" ; then
        pass "container $c: $(echo "$STATUS_LINE" | awk '{$1=""; print}' | xargs)"
      else
        fail "container $c not healthy: $STATUS_LINE"
      fi
    else
      fail "container $c missing"
    fi
  done

  LND_BAL=$(ssh -o ConnectTimeout=5 "$SSH_HOST" 'lncli --tlscertpath=/mnt/HC_Volume_105326177/lnd/tls.cert --macaroonpath=/mnt/HC_Volume_105326177/lnd/data/chain/bitcoin/mainnet/admin.macaroon channelbalance 2>/dev/null' 2>/dev/null || echo '')
  if [ -n "$LND_BAL" ]; then
    LOCAL_SAT=$(echo "$LND_BAL" | jq -r '.local_balance.sat // "?"')
    if [ "$LOCAL_SAT" != "?" ] && [ "$LOCAL_SAT" -gt 100000 ]; then
      pass "LND local balance: $LOCAL_SAT sat (sufficient for paid probes)"
    elif [ "$LOCAL_SAT" != "?" ] && [ "$LOCAL_SAT" -gt 10000 ]; then
      warn "LND local balance: $LOCAL_SAT sat (low — top up before next sprint)"
    else
      fail "LND local balance: $LOCAL_SAT sat (insufficient)"
    fi
  else
    warn "LND channelbalance query failed (lncli unreachable from VM1?)"
  fi
else
  warn "infra checks (containers, LND balance) skipped — re-run without --no-ssh"
fi

# ---------------------------------------------------------------------------
section "2. API endpoints"
# ---------------------------------------------------------------------------
# Format: "<path>|<jq path that must exist>". Pipe-separated to avoid bash 3
# associative-array gymnastics.
ENDPOINTS_LIST=(
  "/api/stats|.data.totalAgents"
  "/api/agents/top?limit=1|.data"
  "/api/services?limit=1|.data"
  "/api/intent/categories|.categories"
  "/api/oracle/budget|.data.lifetime"
  "/api/oracle/peers|.data.peers"
  "/api/openapi.json|.info"
)

for entry in "${ENDPOINTS_LIST[@]}"; do
  endpoint="${entry%|*}"
  jqpath="${entry#*|}"
  RESP=$(curl_get "$API_BASE$endpoint" || echo '')
  if [ -n "$RESP" ] && echo "$RESP" | jq -e "$jqpath" >/dev/null 2>&1; then
    pass "GET $endpoint → 200 + has $jqpath"
  else
    fail "GET $endpoint did not return expected shape ($jqpath)"
  fi
done

# /api/intent — POST + check stage_posteriors + http_method
INTENT_RESP=$(curl -fsS --max-time 10 -X POST "$API_BASE/api/intent" \
  -H 'Content-Type: application/json' \
  -d '{"category":"data/finance","limit":3}' 2>/dev/null || echo '')
if [ -z "$INTENT_RESP" ]; then
  fail "POST /api/intent unreachable"
else
  N_CAND=$(echo "$INTENT_RESP" | jq '.candidates | length')
  [ "${N_CAND:-0}" -gt 0 ] && pass "POST /api/intent → $N_CAND candidates" || fail "POST /api/intent → 0 candidates"

  N_HTTP_METHOD=$(echo "$INTENT_RESP" | jq '[.candidates[] | select(.http_method == "GET" or .http_method == "POST")] | length')
  if [ "${N_HTTP_METHOD:-0}" -eq "${N_CAND:-0}" ] && [ "${N_CAND:-0}" -gt 0 ]; then
    pass "  → http_method present on all $N_CAND candidates"
  else
    fail "  → http_method missing on $((${N_CAND:-0} - ${N_HTTP_METHOD:-0}))/${N_CAND:-0} candidates"
  fi

  N_STAGE=$(echo "$INTENT_RESP" | jq '[.candidates[] | select(.stage_posteriors != null)] | length')
  if [ "${N_STAGE:-0}" -gt 0 ]; then
    pass "  → stage_posteriors present on $N_STAGE/$N_CAND candidates"
    MEANINGFUL_STAGES=$(echo "$INTENT_RESP" | jq '[.candidates[].stage_posteriors.meaningful_stages // [] | length] | max // 0')
    detail "max meaningful stages on any candidate: $MEANINGFUL_STAGES / 5"
  else
    warn "  → stage_posteriors absent on all candidates (table empty? check backfill)"
  fi
fi

# 402 challenge gate
INTENT_402=$(curl -sS --max-time 10 -o /dev/null -w "%{http_code}" -X POST "$API_BASE/api/intent?fresh=true" \
  -H 'Content-Type: application/json' \
  -d '{"category":"data/finance","limit":1}' 2>/dev/null || echo '0')
[ "$INTENT_402" = "402" ] && pass "POST /api/intent?fresh=true → 402 (paid path active)" || fail "POST /api/intent?fresh=true → $INTENT_402 (expected 402)"

# L402 native gate canary — /api/profile/:id is paid (1 sat) so an
# unauthenticated GET should return 402. /api/agent/:hash is FREE
# in the current build (returns 404 for unknown hashes), so it's not
# a reliable L402 canary post-PR-7.
PROFILE_402=$(curl -sS --max-time 10 -o /dev/null -w "%{http_code}" "$API_BASE/api/profile/0000000000000000000000000000000000000000000000000000000000000000" 2>/dev/null || echo '0')
[ "$PROFILE_402" = "402" ] && pass "/api/profile/<zero-hash> → 402 (L402 native gate active)" || warn "/api/profile/<zero-hash> → $PROFILE_402 (expected 402)"

# ---------------------------------------------------------------------------
section "3. Data flow (DB invariants)"
# ---------------------------------------------------------------------------
if [ "$SKIP_SSH" -eq 0 ]; then
  STAGE_COUNTS=$(ssh -o ConnectTimeout=5 "$SSH_HOST" 'docker exec satrank-api node -e "
const {Pool} = require(\"pg\");
const p = new Pool({connectionString: process.env.DATABASE_URL});
p.query(\"SELECT stage, count(*) as n, round(avg(n_obs)::numeric, 2) as avg_n FROM endpoint_stage_posteriors GROUP BY stage ORDER BY stage\").then(r => {console.log(JSON.stringify(r.rows)); p.end();}).catch(e => {console.error(e.message); p.end();});
"' 2>/dev/null || echo '[]')
  STAGE_NAMES_LIST=("challenge" "invoice" "payment" "delivery" "quality")
  for stage in 1 2 3 4 5; do
    NAME="${STAGE_NAMES_LIST[$((stage - 1))]}"
    N_ROWS=$(echo "$STAGE_COUNTS" | jq -r ".[] | select(.stage == $stage) | .n" 2>/dev/null)
    AVG_N=$(echo "$STAGE_COUNTS" | jq -r ".[] | select(.stage == $stage) | .avg_n" 2>/dev/null)
    if [ -n "$N_ROWS" ] && [ "$N_ROWS" != "null" ] && [ "$N_ROWS" -gt 0 ]; then
      pass "stage $stage ($NAME): $N_ROWS endpoints, avg n_obs=$AVG_N"
    else
      # Stage 1 has a backfill — empty = real bug.
      # Stages 2-5 accumulate from live writes (hot-tier crawler / paid probe cron).
      # Re-run the audit later to verify population progress.
      if [ "$stage" -eq 1 ]; then
        fail "stage 1 ($NAME): 0 endpoints — backfill should have populated 342 rows"
      else
        warn "stage $stage ($NAME): 0 endpoints (live writes pending; re-run audit later)"
      fi
    fi
  done

  REVENUE=$(ssh -o ConnectTimeout=5 "$SSH_HOST" 'docker exec satrank-api node -e "
const {Pool} = require(\"pg\");
const p = new Pool({connectionString: process.env.DATABASE_URL});
p.query(\"SELECT type, count(*) as n, sum(amount_sats) as total FROM oracle_revenue_log GROUP BY type\").then(r => {console.log(JSON.stringify(r.rows)); p.end();}).catch(e => {console.error(e.message); p.end();});
"' 2>/dev/null || echo '[]')
  if echo "$REVENUE" | jq -e '. | length > 0' >/dev/null 2>&1; then
    pass "oracle_revenue_log populated: $(echo "$REVENUE" | jq -c '.')"
  else
    warn "oracle_revenue_log empty (no paid intent + no paid probe cycle yet)"
  fi
else
  warn "data flow checks skipped — needs SSH"
fi

# ---------------------------------------------------------------------------
section "4. Cron schedules (boot-logged)"
# ---------------------------------------------------------------------------
if [ "$SKIP_SSH" -eq 0 ]; then
  CRON_LOG=$(ssh -o ConnectTimeout=5 "$SSH_HOST" 'docker logs satrank-crawler 2>&1 | grep -E "cron scheduled|cron disabled|Cron mode enabled|tier timer started" | head -30' 2>/dev/null || echo '')
  for pattern in \
    "Trust assertion cron scheduled" \
    "Oracle announcement cron scheduled" \
    "Paid probe cron scheduled" \
    "Cron mode enabled" \
    "tier.*hot.*timer started"; do
    if echo "$CRON_LOG" | grep -qE "$pattern"; then
      pass "$pattern (logged)"
    else
      fail "$pattern (NOT logged at boot)"
    fi
  done
  if echo "$CRON_LOG" | grep -q "Paid probe cron disabled"; then
    warn "  → paid probe cron is currently DISABLED (PAID_PROBE_ENABLED=false)"
  fi

  AT_QUEUE=$(ssh -o ConnectTimeout=5 "$SSH_HOST" 'atq 2>/dev/null | head -5' 2>/dev/null || echo '')
  if [ -n "$AT_QUEUE" ]; then
    pass "at job queue:"
    echo "$AT_QUEUE" | sed "s|^|         |"
  else
    warn "at queue empty (no scheduled sprint revert?)"
  fi
else
  warn "cron checks skipped — needs SSH"
fi

# ---------------------------------------------------------------------------
section "5. Nostr presence (kind 0 / 30382 / 10040)"
# ---------------------------------------------------------------------------
if command -v npx >/dev/null 2>&1 && [ -f scripts/nostr-verify.ts ]; then
  VERIFY_OUT=$(npx tsx scripts/nostr-verify.ts 2>&1 | grep -E "kind [0-9]+.*[0-9]+ event|Missing|All three" | head -10)
  if echo "$VERIFY_OUT" | grep -q "All three kinds present"; then
    pass "kind 0 + 10040 + 30382 present on at least one relay"
    echo "$VERIFY_OUT" | head -3 | sed "s|^|         |"
  elif echo "$VERIFY_OUT" | grep -q "Missing"; then
    fail "Nostr presence incomplete: $(echo "$VERIFY_OUT" | grep Missing)"
  else
    warn "nostr-verify ran but output unparseable"
    echo "$VERIFY_OUT" | head -3 | sed "s|^|         |"
  fi
else
  warn "Nostr verify skipped — npx tsx scripts/nostr-verify.ts not runnable here"
fi

# ---------------------------------------------------------------------------
section "6. SDK + MCP"
# ---------------------------------------------------------------------------
NPM_VERSION=$(curl -fsS --max-time 5 https://registry.npmjs.org/@satrank/sdk/latest 2>/dev/null | jq -r '.version' 2>/dev/null || echo '')
if [ -n "$NPM_VERSION" ] && [ "$NPM_VERSION" != "null" ]; then
  pass "@satrank/sdk on npm: version $NPM_VERSION"
else
  fail "@satrank/sdk not resolvable on npm"
fi

PYPI_VERSION=$(curl -fsS --max-time 5 https://pypi.org/pypi/satrank/json 2>/dev/null | jq -r '.info.version' 2>/dev/null || echo '')
if [ -n "$PYPI_VERSION" ] && [ "$PYPI_VERSION" != "null" ]; then
  pass "satrank on PyPI: version $PYPI_VERSION"
else
  fail "satrank not resolvable on PyPI"
fi

# ---------------------------------------------------------------------------
section "7. Observability"
# ---------------------------------------------------------------------------
if [ "$SKIP_SSH" -eq 0 ]; then
  # Health-check script lives at /root/satrank-health-check.sh (not under /root/satrank/).
  HC_SCRIPT=$(ssh -o ConnectTimeout=5 "$SSH_HOST" 'ls -la /root/satrank-health-check.sh 2>/dev/null' 2>/dev/null || echo '')
  if [ -n "$HC_SCRIPT" ]; then
    pass "internal health-check script present at /root/satrank-health-check.sh"
    HC_LOG_AGE=$(ssh -o ConnectTimeout=5 "$SSH_HOST" 'stat -c %Y /root/satrank-health-check.log 2>/dev/null' 2>/dev/null || echo '')
    if [ -n "$HC_LOG_AGE" ]; then
      NOW=$(date +%s)
      AGE_SEC=$((NOW - HC_LOG_AGE))
      [ "$AGE_SEC" -lt 1800 ] && pass "  → log fresh (${AGE_SEC}s ago, < 30 min)" || warn "  → log stale (${AGE_SEC}s ago)"
    else
      warn "  → log file missing (cron not yet fired since deploy)"
    fi
  else
    warn "internal health-check script not found at /root/satrank-health-check.sh"
  fi

  # Crawler metrics: hit from VM1 host on 127.0.0.1:9091 (port-mapped from
  # container 0.0.0.0:9091 → host 127.0.0.1:9091). Container has no curl.
  METRICS_OK=$(ssh -o ConnectTimeout=5 "$SSH_HOST" 'curl -fsS --max-time 3 http://127.0.0.1:9091/metrics 2>/dev/null | head -1' 2>/dev/null || echo '')
  [ -n "$METRICS_OK" ] && pass "crawler /metrics reachable on host:9091" || warn "crawler /metrics not reachable on host:9091"
else
  warn "observability checks skipped — needs SSH"
fi

# ---------------------------------------------------------------------------
section "Summary"
# ---------------------------------------------------------------------------
TOTAL=$((PASS_COUNT + FAIL_COUNT + WARN_COUNT))
printf "Total checks:  %d\n" "$TOTAL"
printf "${GREEN}PASS:          %d${NC}\n" "$PASS_COUNT"
printf "${YELLOW}WARN:          %d${NC}\n" "$WARN_COUNT"
printf "${RED}FAIL:          %d${NC}\n" "$FAIL_COUNT"

if [ "$FAIL_COUNT" -gt 0 ]; then
  printf "\n${RED}Failures:${NC}\n"
  for f in "${FAIL_LIST[@]}"; do
    printf "  - %s\n" "$f"
  done
fi

END_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf "\n${BLUE}Completed at %s — exit code = %d${NC}\n" "$END_TS" "$FAIL_COUNT"

exit "$FAIL_COUNT"
