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
# Secrets and data are never shipped: .env.production, data/, *.macaroon,
# and aperture.yaml are all excluded. Host and path are parameterized so the
# public repo never ships infra details.
deploy:
	@test -n "$(SATRANK_HOST)" || (echo "ERROR: set SATRANK_HOST=user@host (ex: root@your.server)" && exit 1)
	@test -n "$(REMOTE_DIR)"   || (echo "ERROR: set REMOTE_DIR=/path/to/satrank (ex: /opt/satrank)" && exit 1)
	rsync -avz \
	  --exclude node_modules \
	  --exclude dist \
	  --exclude .git \
	  --exclude .env \
	  --exclude .env.production \
	  --exclude data \
	  --exclude '*.macaroon' \
	  --exclude aperture.yaml \
	  --exclude '.claude' \
	  . $(SATRANK_HOST):$(REMOTE_DIR)/

# Cleanup
clean:
	rm -rf dist/ data/
