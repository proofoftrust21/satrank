#!/usr/bin/env bash
# scripts/checkScoringHealth.sh
#
# Phase 12C C5 — one-shot sanity check for SatRank prod.
#
# Vérifie en moins d'une minute que :
#   - l'API répond et /api/health n'est pas en status=error,
#   - le scoring n'est pas stale (< 1h vs cutoff configurable),
#   - agents / score_snapshots / streaming posteriors avancent,
#   - service_endpoints n'est pas vide (validation du fix Finding B),
#   - les crawlers ne spamment pas d'ERROR dans les 24 dernières heures.
#
# Usage : ./scripts/checkScoringHealth.sh
#
# Sortie : GREEN (exit 0) / YELLOW (exit 1) / RED (exit 2).
# Chaque check affiche son verdict individuel. Aucune modification de la
# prod : read-only, via SSH + docker exec.
#
# Hypothèses :
#   - prod API :           ssh root@178.104.108.108 docker exec satrank-api
#   - prod Postgres (VM) : ssh root@178.104.142.150 docker exec satrank-postgres
#   - domaine public :     https://satrank.dev
set -u
set -o pipefail

API_HOST_DEFAULT="178.104.108.108"
DB_HOST_DEFAULT="178.104.142.150"
API_URL_DEFAULT="https://satrank.dev"

API_HOST="${SATRANK_API_HOST:-$API_HOST_DEFAULT}"
DB_HOST="${SATRANK_DB_HOST:-$DB_HOST_DEFAULT}"
API_URL="${SATRANK_API_URL:-$API_URL_DEFAULT}"

SSH_OPTS=(-o ConnectTimeout=5 -o BatchMode=yes)

# Seuils
SCORING_STALE_MAX_SEC=3600            # 1h
AGENTS_MIN=1000                        # LND graph populé
SNAPSHOTS_MAX_AGE_SEC=900             # 15 min
POSTERIORS_MAX_AGE_SEC=3600            # 1h
SERVICE_ENDPOINTS_MIN=1               # Finding B fix (post-C3)
CRAWLER_ERROR_MAX_24H=50              # budget tolérance ERROR 24h

# Compteurs de verdict
GREEN=0; YELLOW=0; RED=0

print_green()  { printf '\033[0;32m[OK]\033[0m     %s\n' "$1"; GREEN=$((GREEN + 1)); }
print_yellow() { printf '\033[0;33m[WARN]\033[0m   %s\n' "$1"; YELLOW=$((YELLOW + 1)); }
print_red()    { printf '\033[0;31m[FAIL]\033[0m   %s\n' "$1"; RED=$((RED + 1)); }
print_info()   { printf '\033[0;34m[INFO]\033[0m   %s\n' "$1"; }

# --- check 1 : /api/health ---
print_info "Check 1/6 — /api/health"
HEALTH_JSON="$(curl -fsS -m 10 "$API_URL/api/health" 2>/dev/null)" || {
  print_red "API injoignable sur $API_URL/api/health"
  HEALTH_JSON=""
}
if [ -n "$HEALTH_JSON" ]; then
  # Enveloppe API : { "data": { status, scoringStale, ... } }
  # `//` jq triggers sur false aussi — on passe par `if == null` pour
  # préserver la sémantique booléenne du flag scoringStale.
  STATUS="$(printf '%s' "$HEALTH_JSON" | jq -r '(.data.status // .status) // "missing"')"
  STALE="$(printf '%s' "$HEALTH_JSON" | jq -r '(if .data.scoringStale != null then .data.scoringStale elif .scoringStale != null then .scoringStale else "missing" end) | tostring')"
  AGE_SEC="$(printf '%s' "$HEALTH_JSON" | jq -r '(.data.scoringAgeSec // .scoringAgeSec // 0)')"
  SCHEMA_V="$(printf '%s' "$HEALTH_JSON" | jq -r '(.data.schemaVersion // .schemaVersion) // "missing"')"

  case "$STATUS" in
    ok)      print_green "status=ok, schemaVersion=$SCHEMA_V" ;;
    degraded) print_yellow "status=degraded, schemaVersion=$SCHEMA_V" ;;
    error)   print_red   "status=error, schemaVersion=$SCHEMA_V" ;;
    *)       print_red   "status=$STATUS (inattendu)" ;;
  esac

  if [ "$STALE" = "true" ]; then
    if [ "$AGE_SEC" -gt "$SCORING_STALE_MAX_SEC" ]; then
      print_red "scoringStale=true, scoringAgeSec=${AGE_SEC}s > ${SCORING_STALE_MAX_SEC}s"
    else
      print_yellow "scoringStale=true mais scoringAgeSec=${AGE_SEC}s reste < ${SCORING_STALE_MAX_SEC}s"
    fi
  elif [ "$STALE" = "false" ]; then
    print_green "scoringStale=false, scoringAgeSec=${AGE_SEC}s"
  else
    print_yellow "scoringStale=$STALE (inattendu)"
  fi
fi

# --- check 2 : DB — agents count ---
print_info "Check 2/6 — agents count"
AGENTS_COUNT="$(ssh "${SSH_OPTS[@]}" "root@$DB_HOST" \
  "docker exec satrank-postgres psql -U satrank -d satrank -tAc \"SELECT COUNT(*) FROM agents;\"" 2>/dev/null || echo "0")"
AGENTS_COUNT="${AGENTS_COUNT//[[:space:]]/}"
if [ -z "$AGENTS_COUNT" ] || ! [[ "$AGENTS_COUNT" =~ ^[0-9]+$ ]]; then
  print_red "Requête agents count a échoué"
elif [ "$AGENTS_COUNT" -ge "$AGENTS_MIN" ]; then
  print_green "agents=$AGENTS_COUNT (≥ $AGENTS_MIN)"
else
  print_yellow "agents=$AGENTS_COUNT (< $AGENTS_MIN — crawler LND peut ne pas avoir terminé)"
fi

# --- check 3 : score_snapshots — dernière passe récente ---
print_info "Check 3/6 — score_snapshots freshness"
LATEST_COMPUTED="$(ssh "${SSH_OPTS[@]}" "root@$DB_HOST" \
  "docker exec satrank-postgres psql -U satrank -d satrank -tAc \"SELECT COALESCE(MAX(computed_at), 0) FROM score_snapshots;\"" 2>/dev/null || echo "0")"
LATEST_COMPUTED="${LATEST_COMPUTED//[[:space:]]/}"
NOW="$(date -u +%s)"
if [ -z "$LATEST_COMPUTED" ] || ! [[ "$LATEST_COMPUTED" =~ ^[0-9]+$ ]]; then
  print_red "Requête score_snapshots a échoué"
elif [ "$LATEST_COMPUTED" = "0" ]; then
  print_red "score_snapshots vide"
else
  AGE=$((NOW - LATEST_COMPUTED))
  if [ "$AGE" -le "$SNAPSHOTS_MAX_AGE_SEC" ]; then
    print_green "latest score_snapshots age=${AGE}s (≤ ${SNAPSHOTS_MAX_AGE_SEC}s)"
  elif [ "$AGE" -le 3600 ]; then
    print_yellow "latest score_snapshots age=${AGE}s (cycle rescore pas encore passé ?)"
  else
    print_red "latest score_snapshots age=${AGE}s (> 1h — pipeline scoring bloqué ?)"
  fi
fi

# --- check 4 : endpoint_streaming_posteriors — updates récents ---
print_info "Check 4/6 — streaming posteriors freshness"
LATEST_POSTERIOR="$(ssh "${SSH_OPTS[@]}" "root@$DB_HOST" \
  "docker exec satrank-postgres psql -U satrank -d satrank -tAc \"SELECT COALESCE(MAX(updated_at), 0) FROM endpoint_streaming_posteriors;\"" 2>/dev/null || echo "0")"
LATEST_POSTERIOR="${LATEST_POSTERIOR//[[:space:]]/}"
if [ -z "$LATEST_POSTERIOR" ] || ! [[ "$LATEST_POSTERIOR" =~ ^[0-9]+$ ]]; then
  print_red "Requête endpoint_streaming_posteriors a échoué"
elif [ "$LATEST_POSTERIOR" = "0" ]; then
  print_yellow "endpoint_streaming_posteriors vide (attendu si aucune probe/report encore)"
else
  AGE=$((NOW - LATEST_POSTERIOR))
  if [ "$AGE" -le "$POSTERIORS_MAX_AGE_SEC" ]; then
    print_green "latest endpoint_streaming_posteriors age=${AGE}s (≤ ${POSTERIORS_MAX_AGE_SEC}s)"
  else
    print_yellow "latest endpoint_streaming_posteriors age=${AGE}s (> ${POSTERIORS_MAX_AGE_SEC}s)"
  fi
fi

# --- check 5 : service_endpoints — validation fix Finding B ---
print_info "Check 5/6 — service_endpoints (Finding B / C3 fix)"
SVC_STATS="$(ssh "${SSH_OPTS[@]}" "root@$DB_HOST" \
  "docker exec satrank-postgres psql -U satrank -d satrank -tAc \"SELECT COUNT(*) || '|' || COUNT(*) FILTER (WHERE source='402index') || '|' || COUNT(*) FILTER (WHERE category IS NOT NULL AND agent_hash IS NOT NULL) FROM service_endpoints;\"" 2>/dev/null || echo "0|0|0")"
SVC_STATS="${SVC_STATS//[[:space:]]/}"
IFS='|' read -r SVC_TOTAL SVC_402INDEX SVC_USABLE <<<"$SVC_STATS"
SVC_TOTAL="${SVC_TOTAL:-0}"
SVC_402INDEX="${SVC_402INDEX:-0}"
SVC_USABLE="${SVC_USABLE:-0}"
if [ "$SVC_TOTAL" = "0" ]; then
  print_red "service_endpoints vide — registry crawler n'a pas populé (fix Finding B non déployé ou 402index down)"
elif [ "$SVC_USABLE" -lt "$SERVICE_ENDPOINTS_MIN" ]; then
  print_yellow "service_endpoints=$SVC_TOTAL dont $SVC_USABLE avec category+agent_hash (< $SERVICE_ENDPOINTS_MIN — /api/intent/categories sera peu peuplé)"
else
  print_green "service_endpoints total=$SVC_TOTAL, 402index=$SVC_402INDEX, catégorie+agent=$SVC_USABLE"
fi

# --- check 6 : crawler ERROR logs 24h ---
print_info "Check 6/6 — crawler ERROR logs 24h"
ERROR_COUNT="$(ssh "${SSH_OPTS[@]}" "root@$API_HOST" \
  "docker logs --since 24h satrank-crawler 2>&1 | grep -c '\"level\":50'" 2>/dev/null || echo "0")"
ERROR_COUNT="${ERROR_COUNT//[[:space:]]/}"
if [ -z "$ERROR_COUNT" ] || ! [[ "$ERROR_COUNT" =~ ^[0-9]+$ ]]; then
  print_yellow "Impossible de compter les ERROR (docker logs inaccessible ?)"
elif [ "$ERROR_COUNT" -le "$CRAWLER_ERROR_MAX_24H" ]; then
  print_green "crawler ERROR 24h: $ERROR_COUNT (≤ $CRAWLER_ERROR_MAX_24H)"
else
  print_yellow "crawler ERROR 24h: $ERROR_COUNT (> $CRAWLER_ERROR_MAX_24H — à investiguer)"
fi

# --- verdict final ---
echo ""
echo "────────────────────────────────────────────────────"
printf "Verdict : \033[0;32m%d OK\033[0m  \033[0;33m%d WARN\033[0m  \033[0;31m%d FAIL\033[0m\n" "$GREEN" "$YELLOW" "$RED"
echo "────────────────────────────────────────────────────"

if [ "$RED" -gt 0 ]; then
  echo "Conclusion : RED — action requise."
  exit 2
elif [ "$YELLOW" -gt 0 ]; then
  echo "Conclusion : YELLOW — à surveiller, pas bloquant."
  exit 1
else
  echo "Conclusion : GREEN — prod saine."
  exit 0
fi
