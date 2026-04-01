// SatRank entry point
import { config } from './config';
import { logger } from './logger';
import { createApp } from './app';
import { closeDatabase } from './database/connection';

const app = createApp();

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info({ port: config.PORT, host: config.HOST, env: config.NODE_ENV }, 'SatRank started');
});

// Graceful shutdown
function shutdown() {
  logger.info('Shutting down...');
  server.close(() => {
    closeDatabase();
    logger.info('SatRank stopped gracefully');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
