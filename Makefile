.PHONY: dev build test lint seed seed-prod crawl docker-build docker-up docker-down deploy rollback backup clean

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
deploy:
	./deploy.sh

rollback:
	@echo "Rolling back to previous image on remote..."
	ssh deploy@satrank.io bash -c '\
		cd /opt/satrank && \
		docker tag satrank:previous satrank:latest && \
		docker compose up -d --wait --timeout 60 && \
		cp /opt/satrank/data/satrank.db.pre-deploy /opt/satrank/data/satrank.db 2>/dev/null; \
		echo "Rolled back"'

# Cleanup
clean:
	rm -rf dist/ data/
