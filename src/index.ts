// SatRank entry point
import { config } from './config';
import { logger } from './logger';
import { createApp } from './app';
import { closeDatabase } from './database/connection';

const app = createApp();

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info({ port: config.PORT, host: config.HOST, env: config.NODE_ENV }, 'SatRank started');
});

// Graceful shutdown — stop accepting connections, drain in-flight requests, force exit after 10s
let dbClosed = false;
function safeCloseDatabase() {
  if (!dbClosed) {
    dbClosed = true;
    closeDatabase();
  }
}

function shutdown() {
  logger.info('Shutting down — stopping new connections...');
  server.close(() => {
    safeCloseDatabase();
    logger.info('SatRank stopped gracefully');
    process.exit(0);
  });

  setTimeout(() => {
    logger.warn('Forced shutdown — connections did not close within 10s');
    safeCloseDatabase();
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
