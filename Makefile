.PHONY: dev build test lint seed seed-prod crawl docker-build docker-up docker-down deploy backup clean

# Development
dev:
	npm run dev

build:
	npm run build

test:
	npm test

lint:
	npm run lint

# Database
seed:
	npm run seed

seed-prod: build
	npm run seed:prod

backup:
	@mkdir -p backups
	cp data/satrank.db "backups/satrank-$$(date +%Y%m%d-%H%M%S).db"
	@echo "Backup saved to backups/"

# Crawler
crawl:
	npm run crawl

# Docker
docker-build:
	docker build \
		--build-arg GIT_COMMIT=$$(git rev-parse --short HEAD 2>/dev/null || echo dev) \
		--build-arg BUILD_DATE=$$(date -u +"%Y-%m-%dT%H:%M:%SZ") \
		-t satrank:$$(git rev-parse --short HEAD 2>/dev/null || echo dev) \
		-t satrank:latest .

docker-up: docker-build
	GIT_COMMIT=$$(git rev-parse --short HEAD 2>/dev/null || echo dev) \
	BUILD_DATE=$$(date -u +"%Y-%m-%dT%H:%M:%SZ") \
	docker compose up -d

docker-down:
	docker compose down

# Deploy to VPS
# Usage: SATRANK_HOST=user@host REMOTE_DIR=/path/to/satrank make deploy
# Example: SATRANK_HOST=root@your.server REMOTE_DIR=/opt/satrank make deploy
#
# Exclusions live in .rsync-exclude (authoritative). DO NOT run ad-hoc rsync
# against prod — two incidents in 2026 (.env.production erased in Phase 7,
# probe-pay.macaroon erased in Phase 9) were caused by hand-typed excludes
# that missed entries. Always go through `make deploy`.
# See docs/DEPLOY.md for the full procedure.
deploy:
	@test -n "$(SATRANK_HOST)" || (echo "ERROR: set SATRANK_HOST=user@host (ex: root@your.server)" && exit 1)
	@test -n "$(REMOTE_DIR)"   || (echo "ERROR: set REMOTE_DIR=/path/to/satrank (ex: /opt/satrank)" && exit 1)
	@test -f .rsync-exclude    || (echo "ERROR: .rsync-exclude missing — refusing to deploy without canonical exclusion list" && exit 1)
	@# Stamp build-info.json with the current commit + UTC timestamp + package
	@# version so /api/version reports real values after deploy. The file is
	@# gitignored (volatile per deploy) and rsynced into the container so it
	@# reaches both the builder stage and the runtime stage.
	@printf '{"commit":"%s","buildDate":"%s","version":"%s"}\n' \
	  "$$(git rev-parse --short HEAD 2>/dev/null || echo dev)" \
	  "$$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
	  "$$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)" \
	  > build-info.json
	rsync -avz --exclude-from=.rsync-exclude \
	  . $(SATRANK_HOST):$(REMOTE_DIR)/
	# Audit M9: rsync preserves the local operator's UID by default, which
	# mapped to UNKNOWN:staff on the server (no user with UID 501 exists).
	# Force root:root ownership post-sync so the deploy never leaves files
	# that another user with a matching UID could later modify. The two
	# probe-relevant macaroons (probe-pay.macaroon for paid-probe stages
	# 3-5; invoice.macaroon for /api/deposit) need to stay readable by
	# the container user (uid 1001 = satrank) — chown them back after the
	# recursive root reset. Without this, every deploy breaks paid probes
	# silently with EACCES at boot (Sim 7 follow-up bootstrap discovery).
	#
	# Security audit (Finding 8) — REMOTE_DIR is sent to the remote shell
	# via the SSH command line. Validate it locally before substitution to
	# prevent shell metachars / injection from a hostile env override.
	@if echo '$(REMOTE_DIR)' | grep -qE '[^A-Za-z0-9_/.-]'; then \
		echo "REFUSING: REMOTE_DIR='$(REMOTE_DIR)' contains characters outside [A-Za-z0-9_/.-]"; \
		exit 1; \
	fi
	ssh $(SATRANK_HOST) "chown -R root:root $(REMOTE_DIR) && chmod 600 $(REMOTE_DIR)/.env.production 2>/dev/null && chown 1001:1001 $(REMOTE_DIR)/probe-pay.macaroon $(REMOTE_DIR)/invoice.macaroon 2>/dev/null || true"

# Cleanup
clean:
	rm -rf dist/ data/
