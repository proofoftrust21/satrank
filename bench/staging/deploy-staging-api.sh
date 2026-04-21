#!/usr/bin/env bash
# Phase 12A A3 — deploy the SatRank api container to the staging bench VM.
# Idempotent: safe to re-run. Only the api container is deployed — no
# crawler, no Nostr publisher, no LND daemon. The cloned prod DB at
# /var/lib/satrank/satrank.db (established in A0) is bind-mounted read-write.
#
# Deliberately separate from `make deploy` (the prod path) to prevent
# accidental overwrite of prod's .env.production or compose file.
set -euo pipefail

STAGING_IP="${STAGING_IP:-178.104.142.150}"
REMOTE_DIR="${REMOTE_DIR:-/opt/satrank-staging}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"

echo "[1/4] rsync repo -> staging ${STAGING_IP}:${REMOTE_DIR}"
ssh "root@${STAGING_IP}" "mkdir -p ${REMOTE_DIR}"
rsync -av --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='**/node_modules' \
  --exclude='dist' \
  --exclude='**/dist' \
  --exclude='coverage' \
  --exclude='.DS_Store' \
  --exclude='data/*.db' \
  --exclude='data/*.db-wal' \
  --exclude='data/*.db-shm' \
  --exclude='*.macaroon' \
  --exclude='.env' \
  --exclude='.env.production' \
  --exclude='.env.local' \
  --exclude='bench/observability' \
  --exclude='python-sdk' \
  --exclude='.venv' \
  --exclude='**/.venv' \
  --exclude='sdk/*.tgz' \
  --exclude='*.wheel' \
  --exclude='*.whl' \
  --exclude='docs/phase-*/*.db' \
  "${REPO}/" \
  "root@${STAGING_IP}:${REMOTE_DIR}/"

echo "[2/4] copy staging compose + env to ${REMOTE_DIR} root (docker-compose needs them co-located)"
rsync -av "${HERE}/docker-compose.staging-api.yml" "${HERE}/.env.staging" \
  "root@${STAGING_IP}:${REMOTE_DIR}/"

echo "[3/4] docker compose up api (build+start)"
ssh "root@${STAGING_IP}" "cd ${REMOTE_DIR} && docker compose -f docker-compose.staging-api.yml up -d --build"

echo "[4/4] wait-for /api/health"
for i in {1..30}; do
  if curl -sf -m 3 "http://${STAGING_IP}:8080/api/health" >/dev/null 2>&1; then
    echo "    OK"
    break
  fi
  sleep 4
  if [[ $i -eq 30 ]]; then
    echo "    TIMEOUT waiting for api /api/health" >&2
    ssh "root@${STAGING_IP}" "docker logs --tail 80 satrank-api-staging" >&2 || true
    exit 1
  fi
done

echo
echo "Staging api up:    http://${STAGING_IP}:8080"
echo "Health:            curl http://${STAGING_IP}:8080/api/health"
echo "Metrics (bench):   curl http://${STAGING_IP}:8080/metrics | head -40   # L402_BYPASS opens /metrics on staging"
echo "Prometheus target: http://${STAGING_IP}:9090/targets → satrank-api-staging should flip to UP"
