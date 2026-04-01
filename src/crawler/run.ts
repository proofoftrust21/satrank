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
import { HttpMempoolClient } from './mempoolClient';
import { MempoolCrawler } from './mempoolCrawler';

const CRON_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function runCrawl(observerCrawler: Crawler, mempoolCrawler: MempoolCrawler): Promise<void> {
  // Observer Protocol
  logger.info('Starting Observer Protocol crawl');
  const obsResult = await observerCrawler.run();

  logger.info({
    duration: obsResult.finishedAt - obsResult.startedAt,
    fetched: obsResult.eventsFetched,
    newTx: obsResult.newTransactions,
    newAgents: obsResult.newAgents,
    errors: obsResult.errors.length,
  }, 'Observer Protocol crawl result');

  if (obsResult.errors.length > 0) {
    logger.warn({ errors: obsResult.errors }, 'Errors during Observer Protocol crawl');
  }

  // mempool.space Lightning Network
  logger.info('Starting mempool.space Lightning crawl');
  const memResult = await mempoolCrawler.run();

  logger.info({
    duration: memResult.finishedAt - memResult.startedAt,
    fetched: memResult.nodesFetched,
    newAgents: memResult.newAgents,
    updated: memResult.updatedAgents,
    errors: memResult.errors.length,
  }, 'mempool.space crawl result');

  if (memResult.errors.length > 0) {
    logger.warn({ errors: memResult.errors }, 'Errors during mempool.space crawl');
  }
}

async function main(): Promise<void> {
  const db = getDatabase();
  runMigrations(db);

  const agentRepo = new AgentRepository(db);
  const txRepo = new TransactionRepository(db);
  const observerClient = new HttpObserverClient({
    baseUrl: config.OBSERVER_BASE_URL,
    timeoutMs: config.OBSERVER_TIMEOUT_MS,
  });
  const observerCrawler = new Crawler(observerClient, agentRepo, txRepo);

  const mempoolClient = new HttpMempoolClient();
  const mempoolCrawlerInstance = new MempoolCrawler(mempoolClient, agentRepo);

  const isCron = process.argv.includes('--cron');

  if (isCron) {
    logger.info({ intervalMs: CRON_INTERVAL_MS }, 'Cron mode enabled');

    await runCrawl(observerCrawler, mempoolCrawlerInstance);

    const interval = setInterval(() => {
      runCrawl(observerCrawler, mempoolCrawlerInstance).catch(err => {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Fatal cron crawl error');
      });
    }, CRON_INTERVAL_MS);

    function shutdown() {
      logger.info('Stopping cron crawler');
      clearInterval(interval);
      closeDatabase();
      process.exit(0);
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } else {
    await runCrawl(observerCrawler, mempoolCrawlerInstance);
    closeDatabase();
  }
}

main().catch(err => {
  logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Fatal crawler error');
  closeDatabase();
  process.exit(1);
});
