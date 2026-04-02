// Crawler launch script — single run or cron mode
// Usage: npm run crawl          (single run)
//        npm run crawl -- --cron (every 5 minutes)
import { config } from '../config';
import { logger } from '../logger';
import { crawlDuration } from '../middleware/metrics';
import { getDatabase, closeDatabase } from '../database/connection';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ScoringService } from '../services/scoringService';
import { HttpObserverClient } from './observerClient';
import { Crawler } from './crawler';
import { HttpMempoolClient } from './mempoolClient';
import { MempoolCrawler } from './mempoolCrawler';
import { HttpLnplusClient } from './lnplusClient';
import { LnplusCrawler } from './lnplusCrawler';

const CRON_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function runCrawl(observerCrawler: Crawler, mempoolCrawler: MempoolCrawler, lnplusCrawler: LnplusCrawler, agentRepo: AgentRepository, scoringService: ScoringService, snapshotRepo: SnapshotRepository): Promise<void> {
  // Observer Protocol
  logger.info('Starting Observer Protocol crawl');
  let hrStart = process.hrtime.bigint();
  const obsResult = await observerCrawler.run();
  crawlDuration.observe({ source: 'observer' }, Number(process.hrtime.bigint() - hrStart) / 1e9);

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
  hrStart = process.hrtime.bigint();
  const memResult = await mempoolCrawler.run();
  crawlDuration.observe({ source: 'mempool' }, Number(process.hrtime.bigint() - hrStart) / 1e9);

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

  // LightningNetwork.plus ratings
  logger.info('Starting LN+ ratings crawl');
  try {
    hrStart = process.hrtime.bigint();
    const lnpResult = await lnplusCrawler.run();
    crawlDuration.observe({ source: 'lnplus' }, Number(process.hrtime.bigint() - hrStart) / 1e9);

    logger.info({
      duration: lnpResult.finishedAt - lnpResult.startedAt,
      queried: lnpResult.queried,
      updated: lnpResult.updated,
      notFound: lnpResult.notFound,
      errors: lnpResult.errors.length,
    }, 'LN+ crawl result');

    if (lnpResult.errors.length > 0) {
      logger.warn({ errors: lnpResult.errors }, 'Errors during LN+ crawl');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg }, 'LN+ unavailable, skipping ratings crawl');
  }

  // Pre-compute scores for the top 50 agents by activity
  const topAgents = agentRepo.findTopByActivity(50);
  for (const agent of topAgents) {
    scoringService.computeScore(agent.public_key_hash);
  }
  logger.info({ count: topAgents.length }, 'Scores pre-computed for top agents');

  // Snapshot retention: purge old snapshots to prevent unbounded DB growth
  const purged = snapshotRepo.purgeOldSnapshots();
  if (purged > 0) {
    logger.info({ purged }, 'Old snapshots purged');
  }
}

async function main(): Promise<void> {
  const db = getDatabase();
  runMigrations(db);

  const agentRepo = new AgentRepository(db);
  const txRepo = new TransactionRepository(db);
  const attestationRepo = new AttestationRepository(db);
  const snapshotRepo = new SnapshotRepository(db);
  const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db);

  const observerClient = new HttpObserverClient({
    baseUrl: config.OBSERVER_BASE_URL,
    timeoutMs: config.OBSERVER_TIMEOUT_MS,
  });
  const observerCrawler = new Crawler(observerClient, agentRepo, txRepo);

  const mempoolClient = new HttpMempoolClient();
  const mempoolCrawlerInstance = new MempoolCrawler(mempoolClient, agentRepo);

  const lnplusClient = new HttpLnplusClient();
  const lnplusCrawlerInstance = new LnplusCrawler(lnplusClient, agentRepo);

  const isCron = process.argv.includes('--cron');

  if (isCron) {
    logger.info({ intervalMs: CRON_INTERVAL_MS }, 'Cron mode enabled');

    await runCrawl(observerCrawler, mempoolCrawlerInstance, lnplusCrawlerInstance, agentRepo, scoringService, snapshotRepo);

    const interval = setInterval(() => {
      runCrawl(observerCrawler, mempoolCrawlerInstance, lnplusCrawlerInstance, agentRepo, scoringService, snapshotRepo).catch(err => {
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
    await runCrawl(observerCrawler, mempoolCrawlerInstance, lnplusCrawlerInstance, agentRepo, scoringService, snapshotRepo);
    closeDatabase();
  }
}

main().catch(err => {
  logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Fatal crawler error');
  closeDatabase();
  process.exit(1);
});
