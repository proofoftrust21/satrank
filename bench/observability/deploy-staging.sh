#!/usr/bin/env bash
# Phase 12A observability stack deploy — staging side.
# Idempotent: safe to re-run. Requires: ssh key for root@staging, docker+compose on staging.
#
# Flow:
#   1. rsync bench/observability/ -> staging:/opt/observability
#   2. docker compose up on staging
#   3. wait-for checks on prometheus, grafana, loki
#
# Prod observability: nginx logs only, via ptail-prod sidecar
# (see deploy-prod-promtail.sh). No cross-host scraping of prod /metrics.
set -euo pipefail

STAGING_IP="${STAGING_IP:-178.104.142.150}"
REMOTE_DIR="${REMOTE_DIR:-/opt/observability}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "[1/3] rsync configs -> staging ${STAGING_IP}:${REMOTE_DIR}"
ssh "root@${STAGING_IP}" "mkdir -p ${REMOTE_DIR}"
rsync -av --delete \
  --exclude='.DS_Store' \
  --exclude='*.md' \
  "${HERE}/" \
  "root@${STAGING_IP}:${REMOTE_DIR}/"

echo "[2/3] docker compose up observability stack"
ssh "root@${STAGING_IP}" "cd ${REMOTE_DIR} && docker compose -f docker-compose.staging.yml up -d"

echo "[3/3] wait-for checks"
for svc_url in \
  "http://${STAGING_IP}:9090/-/ready" \
  "http://${STAGING_IP}:3000/api/health" \
  "http://${STAGING_IP}:3100/ready"
do
  echo "  probing ${svc_url}"
  for i in {1..30}; do
    if curl -sf -m 3 "${svc_url}" >/dev/null 2>&1; then
      echo "    OK"
      break
    fi
    sleep 2
    if [[ $i -eq 30 ]]; then
      echo "    TIMEOUT waiting for ${svc_url}" >&2
      exit 1
    fi
  done
done

echo
echo "Stack up. Grafana: http://${STAGING_IP}:3000 (admin / \${GRAFANA_ADMIN_PASSWORD:-admin})"
echo "Prometheus: http://${STAGING_IP}:9090"
echo "Loki: http://${STAGING_IP}:3100"
