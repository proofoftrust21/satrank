// Crawler launch script — single run or cron mode
// Usage: npm run crawl          (single run)
//        npm run crawl -- --cron (every 5 minutes)
import { config } from '../config';
import { logger } from '../logger';
import { getDatabase, closeDatabase } from '../database/connection';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { HttpObserverClient } from './observerClient';
import { Crawler } from './crawler';

const CRON_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function runCrawl(crawler: Crawler): Promise<void> {
  logger.info('Starting Observer Protocol crawl');
  const result = await crawler.run();

  logger.info({
    duration: result.finishedAt - result.startedAt,
    fetched: result.transactionsFetched,
    newTx: result.newTransactions,
    newAgents: result.newAgents,
    errors: result.errors.length,
  }, 'Crawl result');

  if (result.errors.length > 0) {
    logger.warn({ errors: result.errors }, 'Errors during crawl');
  }
}

async function main(): Promise<void> {
  const db = getDatabase();
  runMigrations(db);

  const agentRepo = new AgentRepository(db);
  const txRepo = new TransactionRepository(db);
  const client = new HttpObserverClient({
    baseUrl: config.OBSERVER_BASE_URL,
    timeoutMs: config.OBSERVER_TIMEOUT_MS,
  });
  const crawler = new Crawler(client, agentRepo, txRepo);

  const isCron = process.argv.includes('--cron');

  if (isCron) {
    logger.info({ intervalMs: CRON_INTERVAL_MS }, 'Cron mode enabled');

    // First run immediately
    await runCrawl(crawler);

    // Then every 5 minutes
    const interval = setInterval(() => {
      runCrawl(crawler).catch(err => {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Fatal cron crawl error');
      });
    }, CRON_INTERVAL_MS);

    // Graceful shutdown
    function shutdown() {
      logger.info('Stopping cron crawler');
      clearInterval(interval);
      closeDatabase();
      process.exit(0);
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } else {
    await runCrawl(crawler);
    closeDatabase();
  }
}

main().catch(err => {
  logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Fatal crawler error');
  closeDatabase();
  process.exit(1);
});
