// SatRank V3 — entry point.
//
// Boots the HTTP server, applies the schema, schedules the crawler,
// installs signal handlers. ~30 lines of orchestration.

import { config } from './config.js';
import { logger } from './logger.js';
import { bootstrapSchema, closePool } from './db.js';
import { buildApp } from './api.js';
import { scheduleCrawler } from './crawler.js';

async function main() {
  await bootstrapSchema();

  const app = buildApp();
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'satrank: listening');
  });

  const crawlerTimer = scheduleCrawler();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'satrank: shutting down');
    clearInterval(crawlerTimer);
    server.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err: (err as Error).message, stack: (err as Error).stack }, 'satrank: fatal boot error');
  process.exit(1);
});
