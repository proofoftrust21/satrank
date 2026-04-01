#!/usr/bin/env bash
# SatRank deployment — zero-downtime via docker compose on Hetzner VPS
# Usage: ./deploy.sh [user@host]
set -euo pipefail

# === Configuration ===
REMOTE="${1:-deploy@satrank.io}"
IMAGE="satrank"
REMOTE_DIR="/opt/satrank"
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
HEALTH_URL="http://localhost:3000/api/v1/health"
HEALTH_TIMEOUT=60

echo "=== SatRank Deploy ==="
echo "  Commit : $GIT_COMMIT"
echo "  Date   : $BUILD_DATE"
echo "  Remote : $REMOTE"
echo ""

# === 1. Pre-flight checks ===
echo "→ Pre-flight checks..."

if ! git diff --quiet HEAD 2>/dev/null; then
  echo "  ✗ Working tree is dirty. Commit or stash changes first."
  exit 1
fi

if ! ssh -o ConnectTimeout=5 "$REMOTE" "docker info > /dev/null 2>&1"; then
  echo "  ✗ Cannot reach $REMOTE or Docker is not running."
  exit 1
fi

echo "  ✓ Pre-flight OK"

# === 2. Local tests ===
echo "→ Running tests..."
npm run lint
npm test
echo "  ✓ Tests passed"

# === 3. Build Docker image ===
echo "→ Building Docker image..."
docker build \
  --build-arg GIT_COMMIT="$GIT_COMMIT" \
  --build-arg BUILD_DATE="$BUILD_DATE" \
  -t "$IMAGE:$GIT_COMMIT" \
  -t "$IMAGE:latest" \
  .
echo "  ✓ Image $IMAGE:$GIT_COMMIT built"

# === 4. Transfer image ===
echo "→ Transferring image to $REMOTE..."
docker save "$IMAGE:$GIT_COMMIT" | gzip | ssh "$REMOTE" "docker load"
echo "  ✓ Image transferred"

# === 5. Deploy with zero-downtime ===
echo "→ Deploying on $REMOTE..."
scp docker-compose.yml "$REMOTE:$REMOTE_DIR/docker-compose.yml"

ssh "$REMOTE" bash -s <<DEPLOY_EOF
  set -euo pipefail
  cd $REMOTE_DIR

  export GIT_COMMIT=$GIT_COMMIT
  export BUILD_DATE=$BUILD_DATE

  # Tag the currently running image as "previous" for rollback
  CURRENT_IMAGE=\$(docker compose images api --format json 2>/dev/null | head -1 | grep -oP '"Tag":"[^"]+"' | head -1 | cut -d'"' -f4 || echo "")
  if [ -n "\$CURRENT_IMAGE" ] && [ "\$CURRENT_IMAGE" != "$GIT_COMMIT" ]; then
    docker tag "$IMAGE:\$CURRENT_IMAGE" "$IMAGE:previous" 2>/dev/null || true
    echo "  Tagged $IMAGE:\$CURRENT_IMAGE as $IMAGE:previous"
  fi

  # Backup SQLite database
  if [ -f /opt/satrank/data/satrank.db ]; then
    cp /opt/satrank/data/satrank.db /opt/satrank/data/satrank.db.pre-deploy
    echo "  SQLite backup: satrank.db.pre-deploy"
  fi

  # Zero-downtime: compose recreates the container in-place (no down first)
  # nginx retries on 502 during the ~2s restart window
  docker compose up -d --wait --timeout 60

  # Health check with timeout
  echo "  Waiting for health check..."
  for i in \$(seq 1 $HEALTH_TIMEOUT); do
    if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
      echo "  ✓ SatRank healthy ($GIT_COMMIT)"

      # Clean up old images (keep current + previous)
      docker image prune -f --filter "label!=com.docker.compose.project" > /dev/null 2>&1 || true
      exit 0
    fi
    sleep 1
  done

  # Health check failed — rollback
  echo "  ✗ Health check failed after ${HEALTH_TIMEOUT}s"
  echo "  → Rolling back..."
  docker compose logs --tail=30 api

  if docker image inspect "$IMAGE:previous" > /dev/null 2>&1; then
    docker tag "$IMAGE:previous" "$IMAGE:latest"
    docker compose up -d --wait --timeout 60
    echo "  ✓ Rolled back to previous version"

    # Restore SQLite backup if present
    if [ -f /opt/satrank/data/satrank.db.pre-deploy ]; then
      cp /opt/satrank/data/satrank.db.pre-deploy /opt/satrank/data/satrank.db
      echo "  ✓ SQLite database restored"
    fi
  else
    echo "  ✗ No previous image found for rollback"
  fi
  exit 1
DEPLOY_EOF

echo ""
echo "=== Deploy complete ==="
echo "  Version : $GIT_COMMIT"
echo "  URL     : https://satrank.io/api/v1/health"
