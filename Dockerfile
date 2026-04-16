# Stage 1 — Build TypeScript
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
# build-info.json is written by `make deploy` pre-rsync; in local dev it may
# be missing. The trailing * keeps the COPY optional (no glob match = no-op).
COPY build-info.jso[n] ./
RUN npm run build

# Stage 2 — Install production deps with native modules (better-sqlite3)
FROM node:22-alpine AS deps

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
# --omit=dev is CRITICAL (audit M12): it keeps vitest / vite / tsx / supertest
# out of the runtime image. These carry their own CVEs (e.g. vite path
# traversal GHSA series) that are irrelevant to prod if they are never
# installed. Do NOT change to plain `npm ci` without re-verifying the prod
# dependency tree.
RUN npm ci --omit=dev && npm cache clean --force

# Stage 3 — Minimal runtime (no build tools)
FROM node:22-alpine AS runtime

WORKDIR /app

RUN addgroup -g 1001 -S satrank && adduser -S satrank -u 1001 -G satrank

COPY --from=builder --chown=satrank:satrank /app/dist ./dist
COPY --from=deps    --chown=satrank:satrank /app/node_modules ./node_modules
COPY --chown=satrank:satrank package.json ./
COPY --chown=satrank:satrank public/ ./public/
# build-info.json (optional): populated at deploy time by `make deploy`.
COPY --chown=satrank:satrank build-info.jso[n] ./

RUN mkdir -p /app/data && chown satrank:satrank /app/data

ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
ENV GIT_COMMIT=${GIT_COMMIT}
ENV BUILD_DATE=${BUILD_DATE}
ENV NODE_ENV=production

USER satrank

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

STOPSIGNAL SIGTERM

CMD ["node", "--experimental-require-module", "dist/index.js"]
