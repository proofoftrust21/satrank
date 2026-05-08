FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S satrank && adduser -S satrank -u 1001 -G satrank

COPY --from=builder --chown=satrank:satrank /app/dist ./dist
COPY --from=deps    --chown=satrank:satrank /app/node_modules ./node_modules
COPY --chown=satrank:satrank package.json ./

ENV NODE_ENV=production
USER satrank
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

STOPSIGNAL SIGTERM
CMD ["node", "dist/index.js"]
