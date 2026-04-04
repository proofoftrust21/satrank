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
import { ProbeRepository } from '../repositories/probeRepository';
import { ChannelSnapshotRepository } from '../repositories/channelSnapshotRepository';
import { FeeSnapshotRepository } from '../repositories/feeSnapshotRepository';
import { ProbeCrawler } from './probeCrawler';

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

async function crawlProbe(crawler: ProbeCrawler, probeRepo: ProbeRepository): Promise<void> {
  logger.info('Starting probe routing crawl');
  const hrStart = process.hrtime.bigint();
  const result = await crawler.run();
  const durationSec = Number(process.hrtime.bigint() - hrStart) / 1e9;
  crawlDuration.observe({ source: 'probe' }, durationSec);

  logger.info({
    probed: result.probed,
    reachable: result.reachable,
    unreachable: result.unreachable,
    errors: result.errors.length,
    durationMs: Math.round(durationSec * 1000),
  }, 'Probe crawl result');

  if (result.errors.length > 0) {
    logger.warn({ errors: result.errors }, 'Errors during probe crawl');
  }

  // Purge stale probe results — keep 7 days
  const purged = probeRepo.purgeOlderThan(7 * 24 * 3600);
  if (purged > 0) {
    logger.info({ purged }, 'Old probe results purged');
  }
}

const SCORE_BATCH_SIZE = 500;

/** Score a list of agents in batches, returning the number successfully scored. */
function scoreBatch(agents: { public_key_hash: string }[], scoringService: ScoringService, label: string): number {
  let scored = 0;
  let errors = 0;
  for (let i = 0; i < agents.length; i += SCORE_BATCH_SIZE) {
    const batch = agents.slice(i, i + SCORE_BATCH_SIZE);
    for (const agent of batch) {
      try {
        scoringService.computeScore(agent.public_key_hash);
        scored++;
      } catch (err: unknown) {
        errors++;
        if (errors <= 5) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ agentHash: agent.public_key_hash, error: msg }, `Scoring error (${label})`);
        }
      }
    }
    if (agents.length > SCORE_BATCH_SIZE) {
      logger.info({ scored, total: agents.length, errors }, `Bulk scoring progress (${label})`);
    }
  }
  return scored;
}

function bulkScoreAll(agentRepo: AgentRepository, scoringService: ScoringService, snapshotRepo: SnapshotRepository): void {
  const startMs = Date.now();

  // Phase 1: Score all unscored agents that have exploitable data
  const unscoredCount = agentRepo.countUnscoredWithData();
  logger.info({ unscoredCount }, 'Starting bulk scoring: unscored agents with data');

  if (unscoredCount > 0) {
    const unscored = agentRepo.findUnscoredWithData();
    const scored = scoreBatch(unscored, scoringService, 'unscored');
    logger.info({ scored, total: unscored.length, durationMs: Date.now() - startMs }, 'Bulk scoring complete (unscored agents)');
  }

  // Phase 2: Rescore already-scored agents (refresh with latest data)
  const alreadyScored = agentRepo.findScoredAgents();
  if (alreadyScored.length > 0) {
    const rescoreStart = Date.now();
    const rescored = scoreBatch(alreadyScored, scoringService, 'rescore');
    logger.info({ rescored, total: alreadyScored.length, durationMs: Date.now() - rescoreStart }, 'Bulk rescore complete (existing agents)');
  }

  const purged = snapshotRepo.purgeOldSnapshots();
  if (purged > 0) {
    logger.info({ purged }, 'Old snapshots purged');
  }

  logger.info({ totalDurationMs: Date.now() - startMs }, 'Bulk scoring pipeline finished');
}

// --- Full crawl (all sources once, used for single-run and initial cron boot) ---

async function runFullCrawl(
  observerCrawler: Crawler,
  lndGraphCrawler: LndGraphCrawler,
  mempoolCrawler: MempoolCrawler,
  lnplusCrawler: LnplusCrawler,
  probeCrawlerInstance: ProbeCrawler | null,
  probeRepo: ProbeRepository,
  agentRepo: AgentRepository,
  scoringService: ScoringService,
  snapshotRepo: SnapshotRepository,
): Promise<void> {
  await crawlObserver(observerCrawler);
  await crawlLightning(lndGraphCrawler, mempoolCrawler);

  // Score immediately after LND crawl — don't wait for LN+ or probes
  bulkScoreAll(agentRepo, scoringService, snapshotRepo);

  // LN+ and probe run in parallel — both depend on LND graph data, neither on each other
  const parallelTasks: Promise<void>[] = [];

  parallelTasks.push(
    crawlLnplus(lnplusCrawler).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ error: msg }, 'LN+ unavailable, skipping ratings crawl');
    }),
  );

  if (probeCrawlerInstance) {
    parallelTasks.push(
      crawlProbe(probeCrawlerInstance, probeRepo).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ error: msg }, 'Probe crawl failed, skipping');
      }),
    );
  } else {
    logger.warn('Probe crawler not configured — LND macaroon missing or unreadable. Skipping probe crawl.');
  }

  await Promise.all(parallelTasks);

  // Rescore with LN+ and probe data
  bulkScoreAll(agentRepo, scoringService, snapshotRepo);
}

// --- Main ---

async function main(): Promise<void> {
  const db = getDatabase();
  runMigrations(db);

  const agentRepo = new AgentRepository(db);
  const txRepo = new TransactionRepository(db);
  const attestationRepo = new AttestationRepository(db);
  const snapshotRepo = new SnapshotRepository(db);
  const probeRepo = new ProbeRepository(db);
  const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);

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
  const channelSnapshotRepo = new ChannelSnapshotRepository(db);
  const feeSnapshotRepo = new FeeSnapshotRepository(db);
  const lndGraphCrawlerInstance = new LndGraphCrawler(lndClient, agentRepo, channelSnapshotRepo, feeSnapshotRepo);

  const mempoolClient = new HttpMempoolClient();
  const mempoolCrawlerInstance = new MempoolCrawler(mempoolClient, agentRepo);

  const lnplusClient = new HttpLnplusClient();
  const lnplusCrawlerInstance = new LnplusCrawler(lnplusClient, agentRepo);

  const probeCrawlerInstance = lndClient.isConfigured()
    ? new ProbeCrawler(lndClient, agentRepo, probeRepo, {
        maxPerSecond: config.PROBE_MAX_PER_SECOND,
        amountSats: config.PROBE_AMOUNT_SATS,
      })
    : null;

  if (probeCrawlerInstance) {
    logger.info({
      maxPerSecond: config.PROBE_MAX_PER_SECOND,
      amountSats: config.PROBE_AMOUNT_SATS,
      intervalMs: config.CRAWL_INTERVAL_PROBE_MS,
    }, 'Probe crawler configured');
  } else {
    logger.warn('Probe crawler disabled — LND macaroon not loaded');
  }

  const isCron = process.argv.includes('--cron');

  if (isCron) {
    const intervals = {
      observer: config.CRAWL_INTERVAL_OBSERVER_MS,
      lndGraph: config.CRAWL_INTERVAL_LND_GRAPH_MS,
      lnplus: config.CRAWL_INTERVAL_LNPLUS_MS,
      probe: config.CRAWL_INTERVAL_PROBE_MS,
    };

    logger.info({
      observerMs: intervals.observer,
      lndGraphMs: intervals.lndGraph,
      lnplusMs: intervals.lnplus,
      probeMs: intervals.probe,
    }, 'Cron mode enabled — per-source intervals');

    // Initial full crawl at startup
    await runFullCrawl(
      observerCrawler, lndGraphCrawlerInstance, mempoolCrawlerInstance,
      lnplusCrawlerInstance, probeCrawlerInstance, probeRepo, agentRepo, scoringService, snapshotRepo,
    );

    // Per-source timers
    const timerObserver = setInterval(() => {
      crawlObserver(observerCrawler)
        .then(() => bulkScoreAll(agentRepo, scoringService, snapshotRepo))
        .catch(err => logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Observer crawl error'));
    }, intervals.observer);

    const timerLnd = setInterval(() => {
      crawlLightning(lndGraphCrawlerInstance, mempoolCrawlerInstance)
        .then(() => bulkScoreAll(agentRepo, scoringService, snapshotRepo))
        .catch(err => logger.error({ error: err instanceof Error ? err.message : String(err) }, 'LND graph crawl error'));
    }, intervals.lndGraph);

    const timerLnplus = setInterval(() => {
      crawlLnplus(lnplusCrawlerInstance)
        .then(() => bulkScoreAll(agentRepo, scoringService, snapshotRepo))
        .catch(err => logger.error({ error: err instanceof Error ? err.message : String(err) }, 'LN+ crawl error'));
    }, intervals.lnplus);

    let timerProbe: ReturnType<typeof setInterval> | null = null;
    if (probeCrawlerInstance) {
      timerProbe = setInterval(() => {
        crawlProbe(probeCrawlerInstance, probeRepo)
          .then(() => bulkScoreAll(agentRepo, scoringService, snapshotRepo))
          .catch(err => logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Probe crawl error'));
      }, intervals.probe);
      logger.info({ intervalMs: intervals.probe }, 'Probe cron timer started');
    } else {
      logger.warn('Probe cron timer NOT started — LND not configured');
    }

    function shutdown() {
      logger.info('Stopping cron crawler');
      clearInterval(timerObserver);
      clearInterval(timerLnd);
      clearInterval(timerLnplus);
      if (timerProbe) clearInterval(timerProbe);
      closeDatabase();
      process.exit(0);
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } else {
    await runFullCrawl(
      observerCrawler, lndGraphCrawlerInstance, mempoolCrawlerInstance,
      lnplusCrawlerInstance, probeCrawlerInstance, probeRepo, agentRepo, scoringService, snapshotRepo,
    );
    closeDatabase();
  }
}

main().catch(err => {
  logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Fatal crawler error');
  closeDatabase();
  process.exit(1);
});
