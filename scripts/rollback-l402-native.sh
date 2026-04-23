#!/usr/bin/env bash
# Phase 14D.3.0 rollback — restaure Aperture + config pre-cutover.
#
# Usage :
#   sudo bash scripts/rollback-l402-native.sh /root/aperture-sunset-backup-YYYYMMDD-HHMMSS
#
# Duree attendue : ~30-45 secondes (docker compose recreate api).

set -euo pipefail

BACKUP_DIR="${1:-}"
SATRANK_DIR=/root/satrank
NGINX_CONF=/etc/nginx/sites-enabled/satrank

[[ -n "${BACKUP_DIR}" ]]       || { echo "Usage: $0 <BACKUP_DIR>"; exit 1; }
[[ -d "${BACKUP_DIR}" ]]       || { echo "FATAL: backup dir missing: ${BACKUP_DIR}"; exit 1; }
[[ -f "${BACKUP_DIR}/env-production.bak" ]] || { echo "FATAL: env-production.bak missing in ${BACKUP_DIR}"; exit 1; }
[[ -f "${BACKUP_DIR}/nginx-satrank.bak" ]]  || { echo "FATAL: nginx-satrank.bak missing in ${BACKUP_DIR}"; exit 1; }

echo "=== Rollback from ${BACKUP_DIR} ==="
echo "--- GO/NOGO : proceed with rollback? [y/N] ---"
read -r yn; [[ "${yn}" == "y" ]] || { echo "aborted"; exit 1; }

# 1. Restore .env.production (rebuilds the APERTURE_SHARED_SECRET that the
#    old codepath still needs — Express config.ts exits if it is missing in
#    production).
echo "--- restoring .env.production ---"
cp "${BACKUP_DIR}/env-production.bak" "${SATRANK_DIR}/.env.production"
chmod 600 "${SATRANK_DIR}/.env.production"
chown root:root "${SATRANK_DIR}/.env.production"

# 2. Restore nginx config (re-enables the map $paid_backend routing to :8082)
echo "--- restoring nginx config ---"
cp "${BACKUP_DIR}/nginx-satrank.bak" "${NGINX_CONF}"
nginx -t 2>&1 || { echo "FATAL: nginx -t failed on restored config (unexpected)"; exit 1; }

# 3. Restart Aperture
echo "--- starting aperture ---"
systemctl enable aperture
systemctl start aperture
sleep 2
systemctl is-active aperture | grep -q '^active$' || { echo "FATAL: aperture failed to start"; systemctl status aperture --no-pager | tail -20; exit 1; }

# 4. Recreate api container with the restored .env.production (clears any
#    in-process state from the l402Native middleware — required because the
#    old code path reads APERTURE_SHARED_SECRET at boot, not hot-reload).
echo "--- docker compose up --force-recreate api crawler ---"
cd "${SATRANK_DIR}"
docker compose up -d --force-recreate api crawler

# Wait for healthy
for i in {1..60}; do
    STATUS=$(docker inspect --format='{{.State.Health.Status}}' satrank-api 2>/dev/null || echo "missing")
    echo "[${i}/60] api health: ${STATUS}"
    if [[ "${STATUS}" == "healthy" ]]; then break; fi
    sleep 2
done

STATUS=$(docker inspect --format='{{.State.Health.Status}}' satrank-api 2>/dev/null || echo "missing")
[[ "${STATUS}" == "healthy" ]] || { echo "WARN: api not healthy after 120s — dumping logs"; docker logs --tail 80 satrank-api; exit 1; }

# 5. Reload nginx
echo "--- reloading nginx ---"
systemctl reload nginx
sleep 2

# 6. Smoke checks
echo "--- smoke checks ---"
echo "/api/health :"
curl -sS -o /dev/null -w "  HTTP %{http_code}\n" https://satrank.dev/api/health
echo "/api/agent/<zero-hash> (expect 402 via Aperture, not L402 native) :"
curl -sS -i https://satrank.dev/api/agent/0000000000000000000000000000000000000000000000000000000000000000 \
    | grep -E '^(HTTP|WWW-Authenticate)' | head -3

echo
echo "=== Rollback complete. Aperture restored. ==="
