#!/usr/bin/env bash
# Phase 14D.3.0 etape 6 — cutover Aperture -> L402 natif Express.
#
# A executer UNIQUEMENT sur la VM prod (178.104.108.108), apres avoir pre-stage
# les 2 fichiers suivants dans /tmp via scp depuis la machine operateur :
#
#   /tmp/.env.production.new      (nouvelle env avec L402_* + OPERATOR_BYPASS_SECRET)
#   /tmp/satrank-nginx.new        (nouvelle nginx config sans map $paid_backend)
#
# Downtime attendu : ~8-15 secondes (docker compose up --force-recreate api).
#
# Usage :
#   sudo bash scripts/cutover-l402-native.sh
#
# En cas d'echec : le script sort avec code != 0 ; lancer scripts/rollback-l402-native.sh
# avec le BACKUP_DIR imprime en tete.

set -euo pipefail

# --- Preflight -----------------------------------------------------------
STAGED_ENV=/tmp/.env.production.new
STAGED_NGINX=/tmp/satrank-nginx.new
SATRANK_DIR=/root/satrank
NGINX_CONF=/etc/nginx/sites-enabled/satrank
APERTURE_DB=/root/.aperture/aperture.db
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR=/root/aperture-sunset-backup-${TIMESTAMP}

echo "=== L402 native cutover — ${TIMESTAMP} ==="
echo "BACKUP_DIR=${BACKUP_DIR}"
echo

[[ -f "${STAGED_ENV}" ]]   || { echo "FATAL: staged env missing: ${STAGED_ENV}"; exit 1; }
[[ -f "${STAGED_NGINX}" ]] || { echo "FATAL: staged nginx missing: ${STAGED_NGINX}"; exit 1; }
[[ -f "${SATRANK_DIR}/.env.production" ]] || { echo "FATAL: current .env.production not found"; exit 1; }
[[ -f "${NGINX_CONF}" ]] || { echo "FATAL: current nginx config not found"; exit 1; }

# Preview staged env variable names (values hidden)
echo "--- staged .env.production (names only) ---"
sed 's/=.*/=<masked>/' "${STAGED_ENV}" | head -40
echo "---"

# Sanity : required new vars present
grep -q '^L402_MACAROON_SECRET=' "${STAGED_ENV}"   || { echo "FATAL: L402_MACAROON_SECRET missing in staged env"; exit 1; }
grep -q '^OPERATOR_BYPASS_SECRET=' "${STAGED_ENV}" || { echo "FATAL: OPERATOR_BYPASS_SECRET missing in staged env"; exit 1; }
grep -q '^LND_INVOICE_MACAROON_PATH=' "${STAGED_ENV}" || { echo "FATAL: LND_INVOICE_MACAROON_PATH missing (featureFlags.l402Native requires it)"; exit 1; }

# Sanity : staged nginx config must not contain 'aperture' (guard against a bad paste)
if grep -qi '8082\|aperture' "${STAGED_NGINX}"; then
    echo "WARN: staged nginx still references aperture/8082. Continue anyway? [y/N]"
    read -r yn; [[ "${yn}" == "y" ]] || exit 1
fi

echo "--- GO/NOGO : proceed with cutover? [y/N] ---"
read -r yn; [[ "${yn}" == "y" ]] || { echo "aborted"; exit 1; }

# --- Snapshot everything ------------------------------------------------
mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"
cp -a "${SATRANK_DIR}/.env.production" "${BACKUP_DIR}/env-production.bak"
cp -a "${NGINX_CONF}"                   "${BACKUP_DIR}/nginx-satrank.bak"
if [[ -f "${APERTURE_DB}" ]]; then
    sqlite3 "${APERTURE_DB}" ".backup ${BACKUP_DIR}/aperture.db.backup" || echo "WARN: aperture.db backup failed (non-fatal)"
fi
docker compose -f "${SATRANK_DIR}/docker-compose.yml" images api crawler > "${BACKUP_DIR}/docker-images-pre.txt" 2>&1 || true
systemctl is-active aperture > "${BACKUP_DIR}/aperture-status-pre.txt" 2>&1 || true
echo "Snapshot -> ${BACKUP_DIR}"
ls -la "${BACKUP_DIR}"

# --- Stop Aperture ------------------------------------------------------
echo "--- stopping aperture service ---"
systemctl stop aperture
systemctl disable aperture || true
systemctl is-active aperture && { echo "FATAL: aperture still active"; exit 1; } || echo "aperture stopped"

# --- Swap .env.production ----------------------------------------------
echo "--- swapping .env.production ---"
cp "${STAGED_ENV}" "${SATRANK_DIR}/.env.production"
chmod 600 "${SATRANK_DIR}/.env.production"
chown root:root "${SATRANK_DIR}/.env.production"

# --- Swap nginx config (but DO NOT reload yet) -------------------------
echo "--- swapping nginx config ---"
cp "${STAGED_NGINX}" "${NGINX_CONF}"
nginx -t 2>&1 || {
    echo "FATAL: nginx -t failed. Restoring previous config and aborting.";
    cp "${BACKUP_DIR}/nginx-satrank.bak" "${NGINX_CONF}";
    systemctl start aperture;
    exit 1;
}

# --- Rebuild + recreate api + crawler (downtime starts here) -----------
echo "--- docker compose build + up --force-recreate (downtime ~8-15s) ---"
cd "${SATRANK_DIR}"
docker compose build api crawler
docker compose up -d --force-recreate api crawler

# Wait for api healthy (max 180s — matches compose start_period 120s + margin)
echo "--- waiting for api healthy ---"
for i in {1..60}; do
    STATUS=$(docker inspect --format='{{.State.Health.Status}}' satrank-api 2>/dev/null || echo "missing")
    echo "[${i}/60] api health: ${STATUS}"
    if [[ "${STATUS}" == "healthy" ]]; then break; fi
    if [[ "${STATUS}" == "unhealthy" ]]; then
        echo "FATAL: api unhealthy. Dump logs + abort.";
        docker logs --tail 80 satrank-api;
        exit 1;
    fi
    sleep 3
done

STATUS=$(docker inspect --format='{{.State.Health.Status}}' satrank-api 2>/dev/null || echo "missing")
[[ "${STATUS}" == "healthy" ]] || { echo "FATAL: api not healthy after 180s"; exit 1; }

# --- Reload nginx (finishes the cutover) -------------------------------
echo "--- reloading nginx ---"
systemctl reload nginx
sleep 2

# --- Immediate smoke checks --------------------------------------------
echo "--- smoke checks (satrank.dev) ---"
echo "/api/health :"
curl -sS -o /dev/null -w "  HTTP %{http_code}\n" https://satrank.dev/api/health
echo "/api/agent/<zero-hash> (expect 402 + WWW-Authenticate: L402) :"
curl -sS -i https://satrank.dev/api/agent/0000000000000000000000000000000000000000000000000000000000000000 \
    | grep -E '^(HTTP|WWW-Authenticate)' | head -3
echo "/api/probe (POST, expect 402 + invoice lnbc50n...) :"
curl -sS -i -X POST https://satrank.dev/api/probe -H 'content-type: application/json' -d '{"url":"https://example.com"}' \
    | grep -E '^(HTTP|WWW-Authenticate)' | head -3

echo
echo "=== Cutover complete. BACKUP_DIR=${BACKUP_DIR} ==="
echo "Next: end-to-end manual test (Wallet of Satoshi paiement reel)."
echo "Rollback if needed : bash scripts/rollback-l402-native.sh ${BACKUP_DIR}"
