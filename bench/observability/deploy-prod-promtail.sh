#!/usr/bin/env bash
# Phase 12A — Deploy promtail-only daemon on PROD.
# AUTHORIZATION REQUIRED: this is the ONE authorized prod-side daemon addition
# for Phase 12A. Do not run without explicit validation.
#
# Flow:
#   1. rsync prod/ to prod:/opt/observability-prod
#   2. docker compose up promtail-prod
#   3. health check
set -euo pipefail

PROD_IP="${PROD_IP:-178.104.108.108}"
STAGING_IP="${STAGING_IP:-178.104.142.150}"
REMOTE_DIR="${REMOTE_DIR:-/opt/observability-prod}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROD_SRC="${HERE}/prod"

# Safety gate — operator must set PHASE_12A_PROD_PROMTAIL_OK=yes explicitly.
if [[ "${PHASE_12A_PROD_PROMTAIL_OK:-}" != "yes" ]]; then
  echo "REFUSED: set PHASE_12A_PROD_PROMTAIL_OK=yes to confirm you have Romain's approval" >&2
  exit 2
fi

echo "[1/3] rsync prod promtail config -> ${PROD_IP}:${REMOTE_DIR}"
ssh "root@${PROD_IP}" "mkdir -p ${REMOTE_DIR}"
rsync -av --delete \
  --exclude='.DS_Store' \
  "${PROD_SRC}/" \
  "root@${PROD_IP}:${REMOTE_DIR}/"

echo "[2/3] docker compose up promtail-prod (push target: staging Loki ${STAGING_IP}:3100)"
ssh "root@${PROD_IP}" \
  "cd ${REMOTE_DIR} && \
   STAGING_LOKI_URL=http://${STAGING_IP}:3100 \
   docker compose -f docker-compose.prod-promtail.yml up -d"

echo "[3/3] verify promtail is shipping logs"
sleep 5
ssh "root@${PROD_IP}" "docker logs --tail 20 ptail-prod"

echo
echo "Promtail-prod deployed. Verify ingestion from Grafana/Loki:"
echo "  http://${STAGING_IP}:3000 -> Explore -> Loki -> {job=\"nginx\", host=\"prod\"}"
