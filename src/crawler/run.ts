// Crawler launch script — single run or cron mode with per-source intervals
// Usage: npm run crawl          (single run — all sources once)
//        npm run crawl -- --cron (per-source intervals, configurable)
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
import { HttpLndGraphClient } from './lndGraphClient';
import { LndGraphCrawler } from './lndGraphCrawler';
import { HttpLnplusClient } from './lnplusClient';
import { LnplusCrawler } from './lnplusCrawler';

// --- Per-source crawl functions ---

async function crawlObserver(crawler: Crawler): Promise<void> {
  logger.info('Starting Observer Protocol crawl');
  const hrStart = process.hrtime.bigint();
  const result = await crawler.run();
  crawlDuration.observe({ source: 'observer' }, Number(process.hrtime.bigint() - hrStart) / 1e9);

  logger.info({
    duration: result.finishedAt - result.startedAt,
    fetched: result.eventsFetched,
    newTx: result.newTransactions,
    newAgents: result.newAgents,
    errors: result.errors.length,
  }, 'Observer Protocol crawl result');

  if (result.errors.length > 0) {
    logger.warn({ errors: result.errors }, 'Errors during Observer Protocol crawl');
  }
}

async function crawlLightning(lndGraphCrawler: LndGraphCrawler, mempoolCrawler: MempoolCrawler): Promise<void> {
  let lndSuccess = false;
  logger.info('Starting LND graph crawl');
  const hrStart = process.hrtime.bigint();

  try {
    const lndResult = await lndGraphCrawler.run();
    crawlDuration.observe({ source: 'lnd_graph' }, Number(process.hrtime.bigint() - hrStart) / 1e9);

    if (lndResult.syncedToGraph && lndResult.errors.length === 0) {
      lndSuccess = true;
      logger.info({
        duration: lndResult.finishedAt - lndResult.startedAt,
        fetched: lndResult.nodesFetched,
        newAgents: lndResult.newAgents,
        updated: lndResult.updatedAgents,
      }, 'LND graph crawl result');
    } else {
      logger.warn({
        synced: lndResult.syncedToGraph,
        errors: lndResult.errors,
      }, 'LND graph crawl incomplete — falling back to mempool.space');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg }, 'LND graph unavailable — falling back to mempool.space');
  }

  if (!lndSuccess) {
    logger.info('Starting mempool.space Lightning crawl (fallback)');
    const hrFallback = process.hrtime.bigint();
    const memResult = await mempoolCrawler.run();
    crawlDuration.observe({ source: 'mempool' }, Number(process.hrtime.bigint() - hrFallback) / 1e9);

    logger.info({
      duration: memResult.finishedAt - memResult.startedAt,
      fetched: memResult.nodesFetched,
      newAgents: memResult.newAgents,
      updated: memResult.updatedAgents,
      errors: memResult.errors.length,
    }, 'mempool.space crawl result (fallback)');

    if (memResult.errors.length > 0) {
      logger.warn({ errors: memResult.errors }, 'Errors during mempool.space crawl');
    }
  }
}

async function crawlLnplus(crawler: LnplusCrawler): Promise<void> {
  logger.info('Starting LN+ ratings crawl');
  const hrStart = process.hrtime.bigint();
  const result = await crawler.run();
  crawlDuration.observe({ source: 'lnplus' }, Number(process.hrtime.bigint() - hrStart) / 1e9);

  logger.info({
    duration: result.finishedAt - result.startedAt,
    queried: result.queried,
    updated: result.updated,
    notFound: result.notFound,
    errors: result.errors.length,
  }, 'LN+ crawl result');

  if (result.errors.length > 0) {
    logger.warn({ errors: result.errors }, 'Errors during LN+ crawl');
  }
}

// Cooldown prevents redundant precompute runs when multiple crawl timers fire close together
const PRECOMPUTE_COOLDOWN_MS = 30_000; // 30 seconds
let lastPrecomputeAt = 0;

function precomputeAndPurge(agentRepo: AgentRepository, scoringService: ScoringService, snapshotRepo: SnapshotRepository): void {
  const now = Date.now();
  if (now - lastPrecomputeAt < PRECOMPUTE_COOLDOWN_MS) {
    logger.debug('precomputeAndPurge skipped — cooldown active');
    return;
  }
  lastPrecomputeAt = now;

  const topAgents = agentRepo.findTopByActivity(50);
  for (const agent of topAgents) {
    scoringService.computeScore(agent.public_key_hash);
  }
  logger.info({ count: topAgents.length }, 'Scores pre-computed for top agents');

  const purged = snapshotRepo.purgeOldSnapshots();
  if (purged > 0) {
    logger.info({ purged }, 'Old snapshots purged');
  }
}

// --- Full crawl (all sources once, used for single-run and initial cron boot) ---

async function runFullCrawl(
  observerCrawler: Crawler,
  lndGraphCrawler: LndGraphCrawler,
  mempoolCrawler: MempoolCrawler,
  lnplusCrawler: LnplusCrawler,
  agentRepo: AgentRepository,
  scoringService: ScoringService,
  snapshotRepo: SnapshotRepository,
): Promise<void> {
  await crawlObserver(observerCrawler);
  await crawlLightning(lndGraphCrawler, mempoolCrawler);

  try {
    await crawlLnplus(lnplusCrawler);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg }, 'LN+ unavailable, skipping ratings crawl');
  }

  precomputeAndPurge(agentRepo, scoringService, snapshotRepo);
}

// --- Main ---

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

  const lndClient = new HttpLndGraphClient({
    restUrl: config.LND_REST_URL,
    macaroonPath: config.LND_MACAROON_PATH,
    timeoutMs: config.LND_TIMEOUT_MS,
  });
  const lndGraphCrawlerInstance = new LndGraphCrawler(lndClient, agentRepo);

  const mempoolClient = new HttpMempoolClient();
  const mempoolCrawlerInstance = new MempoolCrawler(mempoolClient, agentRepo);

  const lnplusClient = new HttpLnplusClient();
  const lnplusCrawlerInstance = new LnplusCrawler(lnplusClient, agentRepo);

  const isCron = process.argv.includes('--cron');

  if (isCron) {
    const intervals = {
      observer: config.CRAWL_INTERVAL_OBSERVER_MS,
      lndGraph: config.CRAWL_INTERVAL_LND_GRAPH_MS,
      lnplus: config.CRAWL_INTERVAL_LNPLUS_MS,
    };

    logger.info({
      observerMs: intervals.observer,
      lndGraphMs: intervals.lndGraph,
      lnplusMs: intervals.lnplus,
    }, 'Cron mode enabled — per-source intervals');

    // Initial full crawl at startup
    await runFullCrawl(
      observerCrawler, lndGraphCrawlerInstance, mempoolCrawlerInstance,
      lnplusCrawlerInstance, agentRepo, scoringService, snapshotRepo,
    );

    // Per-source timers
    const timerObserver = setInterval(() => {
      crawlObserver(observerCrawler)
        .then(() => precomputeAndPurge(agentRepo, scoringService, snapshotRepo))
        .catch(err => logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Observer crawl error'));
    }, intervals.observer);

    const timerLnd = setInterval(() => {
      crawlLightning(lndGraphCrawlerInstance, mempoolCrawlerInstance)
        .then(() => precomputeAndPurge(agentRepo, scoringService, snapshotRepo))
        .catch(err => logger.error({ error: err instanceof Error ? err.message : String(err) }, 'LND graph crawl error'));
    }, intervals.lndGraph);

    const timerLnplus = setInterval(() => {
      crawlLnplus(lnplusCrawlerInstance)
        .catch(err => logger.error({ error: err instanceof Error ? err.message : String(err) }, 'LN+ crawl error'));
    }, intervals.lnplus);

    function shutdown() {
      logger.info('Stopping cron crawler');
      clearInterval(timerObserver);
      clearInterval(timerLnd);
      clearInterval(timerLnplus);
      closeDatabase();
      process.exit(0);
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } else {
    await runFullCrawl(
      observerCrawler, lndGraphCrawlerInstance, mempoolCrawlerInstance,
      lnplusCrawlerInstance, agentRepo, scoringService, snapshotRepo,
    );
    closeDatabase();
  }
}

main().catch(err => {
  logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Fatal crawler error');
  closeDatabase();
  process.exit(1);
});
