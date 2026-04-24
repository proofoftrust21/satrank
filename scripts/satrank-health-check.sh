#!/bin/bash
# SatRank internal health degradation check
# Runs every 5 min via cron, alerts on degraded states not caught by external monitors
# Sends to: alex.gauch@pm.me via msmtp

set -uo pipefail

LOG_FILE="/root/satrank-health-check.log"
HEALTH_URL="http://localhost:3000/api/health"
EMAIL_RECIPIENT="alex.gauch@pm.me"
EXPECTED_SCHEMA=41
SCORING_AGE_THRESHOLD=7200
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

log() {
  echo "$TIMESTAMP $1" >> "$LOG_FILE"
}

alert_email() {
  local subject="$1"
  local body="$2"
  if command -v msmtp >/dev/null 2>&1; then
    {
      echo "From: SatRank Monitor <romain.slowmingo@gmail.com>"
      echo "To: $EMAIL_RECIPIENT"
      echo "Subject: [SatRank ALERT] $subject"
      echo ""
      printf '%b\n' "$body"
      echo ""
      echo "Timestamp: $TIMESTAMP"
      echo "Host: $(hostname)"
    } | msmtp -t
    log "Email alert sent: $subject"
  fi
}

HEALTH_JSON=$(curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null || echo '')

if [ -z "$HEALTH_JSON" ]; then
  alert_email "API health endpoint unreachable" "curl failed against $HEALTH_URL (timeout or non-2xx)"
  log "FAIL: health endpoint unreachable"
  exit 1
fi

# /api/health envelope: {"data":{"status":"ok",...}}
STATUS=$(echo "$HEALTH_JSON" | jq -r '.data.status // "unknown"')
DB_STATUS=$(echo "$HEALTH_JSON" | jq -r '.data.dbStatus // "unknown"')
LND_STATUS=$(echo "$HEALTH_JSON" | jq -r '.data.lndStatus // "unknown"')
SCHEMA_VERSION=$(echo "$HEALTH_JSON" | jq -r '.data.schemaVersion // 0')
SCORING_STALE=$(echo "$HEALTH_JSON" | jq -r '.data.scoringStale // false')
SCORING_AGE_SEC=$(echo "$HEALTH_JSON" | jq -r '.data.scoringAgeSec // 0')

DEGRADED=0
ALERT_BODY=""

if [ "$STATUS" != "ok" ]; then
  ALERT_BODY+="status=$STATUS (expected ok)\n"
  DEGRADED=1
fi
if [ "$DB_STATUS" != "ok" ]; then
  ALERT_BODY+="dbStatus=$DB_STATUS (expected ok)\n"
  DEGRADED=1
fi
if [ "$LND_STATUS" != "ok" ]; then
  ALERT_BODY+="lndStatus=$LND_STATUS (expected ok)\n"
  DEGRADED=1
fi
if [ "$SCHEMA_VERSION" != "$EXPECTED_SCHEMA" ]; then
  ALERT_BODY+="schemaVersion=$SCHEMA_VERSION (expected $EXPECTED_SCHEMA)\n"
  DEGRADED=1
fi
if [ "$SCORING_STALE" = "true" ]; then
  ALERT_BODY+="scoringStale=true (scores not updating)\n"
  DEGRADED=1
fi
if [ "$SCORING_AGE_SEC" -gt "$SCORING_AGE_THRESHOLD" ]; then
  ALERT_BODY+="scoringAgeSec=$SCORING_AGE_SEC (> ${SCORING_AGE_THRESHOLD}s, scoring loop may be stuck)\n"
  DEGRADED=1
fi

if [ "$DEGRADED" -eq 1 ]; then
  ALERT_BODY+="\nFull /api/health body:\n$HEALTH_JSON"
  alert_email "SatRank health degraded" "$ALERT_BODY"
  log "DEGRADED status=$STATUS db=$DB_STATUS lnd=$LND_STATUS schema=$SCHEMA_VERSION stale=$SCORING_STALE ageSec=$SCORING_AGE_SEC"
  exit 1
fi

log "OK status=$STATUS db=$DB_STATUS lnd=$LND_STATUS schema=$SCHEMA_VERSION ageSec=$SCORING_AGE_SEC"
