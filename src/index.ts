// SatRank entry point
import { config } from './config';
import { logger } from './logger';
import { createApp } from './app';
import { closeDatabase } from './database/connection';

// Global safety net for unhandled promise rejections and uncaught
// exceptions. Node 22+ crashes the process by default on unhandled
// rejections; a single orphan promise in a third-party library (e.g.
// nostr-tools when a relay WebSocket drops mid-publish) would take down
// the API container and interrupt every in-flight request. These
// handlers log the failure and keep the process alive.
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.warn({ err: msg, promise: String(promise).slice(0, 80) }, 'Unhandled promise rejection — swallowed to keep api alive');
});
process.on('uncaughtException', (err: Error) => {
  logger.error({ err: err.message, stack: err.stack?.split('\n').slice(0, 5) }, 'Uncaught exception — swallowed to keep api alive');
});

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
