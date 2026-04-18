// Crawler launch script — single run or cron mode with per-source intervals
// Usage: npm run crawl          (single run — all sources once)
//        npm run crawl -- --cron (per-source intervals, configurable)
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config';
import { logger } from '../logger';
import { crawlDuration } from '../middleware/metrics';
import { startCrawlerMetricsServer } from './metricsServer';
import { getDatabase, closeDatabase } from '../database/connection';
import { runMigrations } from '../database/migrations';
import { acquireBulkRescoreLock } from '../utils/advisoryLock';
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
import { SurvivalService } from '../services/survivalService';
import { runRetentionCleanup } from '../database/retention';
import { RETENTION_INTERVAL_MS } from '../config/retention';
import { DualWriteLogger } from '../utils/dualWriteLogger';

// --- Uncaught exception / unhandled rejection safety net ---
// nostr-tools internals (Relay.publish) are known to create orphan promises
// when the underlying WebSocket closes mid-publish: the `ret` promise is
// registered in `openEventPublishes` with a setTimeout that rejects it
// ~10s later, after `send()` has already thrown synchronously and the
// async wrapper has returned a rejected promise without the caller ever
// receiving `ret`. Node 22+ crashes the process on unhandled rejections
// by default. We catch these at the top of the crawler so the DVM fan-out
// and NIP-85 publisher keep running even when one of the three relays has
// a stale connection. The handler logs the error so nothing goes
// silently missing.
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.warn({ err: msg, promise: String(promise).slice(0, 80) }, 'Unhandled promise rejection — swallowed to keep crawler alive');
});
process.on('uncaughtException', (err: Error) => {
  logger.error({ err: err.message, stack: err.stack?.split('\n').slice(0, 5) }, 'Uncaught exception — swallowed to keep crawler alive');
});

// --- Liveness heartbeat ---
// Docker healthcheck (docker-compose.yml, crawler service) reads the mtime
// of /tmp/crawler.heartbeat to decide if the event loop is still responsive.
// We touch the file on a dedicated 60s timer from the very start of the
// cron path — independent of any crawl — so a long-running crawl doesn't
// trip the healthcheck and a real event-loop stall does.
const HEARTBEAT_PATH = '/tmp/crawler.heartbeat';
const HEARTBEAT_INTERVAL_MS = 60_000;

function touchHeartbeat(): void {
  try {
    writeFileSync(HEARTBEAT_PATH, String(Date.now()));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg, path: HEARTBEAT_PATH }, 'Failed to write liveness heartbeat');
  }
}

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
  const purged = await probeRepo.purgeOlderThan(7 * 24 * 3600);
  if (purged > 0) {
    logger.info({ purged }, 'Old probe results purged');
  }
}

// Fossil sweep — agents not seen in this window are flagged stale=1.
// A sighting (graph crawl, probe, or graph update) restores stale=0 automatically.
const STALE_THRESHOLD_SEC = 90 * 86400; // 90 days
const STALE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

function runStaleSweep(agentRepo: AgentRepository): void {
  try {
    const flagged = agentRepo.markStaleByAge(STALE_THRESHOLD_SEC);
    const total = agentRepo.countStale();
    logger.info({ flagged, totalStale: total }, 'Stale sweep complete');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, 'Stale sweep failed');
  }
}

// Batch size for scoring + event loop yield. 500 was too large — each
// score takes ~15ms, so 500 scores = ~7.5s of continuous blocking. Relay
// WebSocket pings fire every 5s and timed out during the blocked window,
// killing DVM subscriptions. At 50 per batch, the blocking window is
// ~750ms — well under the ping interval.
const SCORE_BATCH_SIZE = 50;

/** Score a list of agents in batches, returning the number successfully scored. */
// Yields the event loop between scoring batches via setImmediate so that
// WebSocket pings (DVM relay subscriptions, heartbeat) can fire during
// the 5+ minute scoring pipeline. Without this, the event loop was blocked
// for the entire pipeline and relay subscriptions expired silently.
async function scoreBatch(agents: { public_key_hash: string }[], scoringService: ScoringService, label: string): Promise<number> {
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
          logger.warn({ agentHash: agent.public_key_hash.slice(0, 12), error: msg }, `Scoring error (${label})`);
        }
      }
    }
    // Log every 500 scored (not every batch — that would be too verbose at batch=50)
    if (scored % 500 === 0 && scored > 0) {
      logger.info({ scored, total: agents.length, errors }, `Bulk scoring progress (${label})`);
    }
    // Yield the event loop so WebSocket pings and other async work
    // (DVM subscriptions, heartbeat, etc.) can process between batches.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return scored;
}

// Lock path lives next to the DB on the shared docker volume so both
// containers (and any manual script running inside either) see the same lock.
const BULK_RESCORE_LOCK_PATH = join(dirname(config.DB_PATH), '.bulk-rescore.lock');

async function bulkScoreAll(agentRepo: AgentRepository, scoringService: ScoringService, snapshotRepo: SnapshotRepository): Promise<void> {
  // Advisory lock: only one bulk rescore at a time across all processes
  // sharing this DB. If another process holds it, skip — the next cron
  // cycle will pick up whatever this one would have scored. We don't wait
  // because a rescore in flight will produce fresh snapshots anyway.
  const lock = acquireBulkRescoreLock(BULK_RESCORE_LOCK_PATH);
  if (!lock) {
    logger.info({ lockPath: BULK_RESCORE_LOCK_PATH }, 'Bulk rescore skipped — another process holds the lock');
    return;
  }

  const startMs = Date.now();
  try {
    // Phase 1: Score all unscored agents that have exploitable data
    const unscoredCount = agentRepo.countUnscoredWithData();
    logger.info({ unscoredCount }, 'Starting bulk scoring: unscored agents with data');

    if (unscoredCount > 0) {
      const unscored = agentRepo.findUnscoredWithData();
      const scored = await scoreBatch(unscored, scoringService, 'unscored');
      logger.info({ scored, total: unscored.length, durationMs: Date.now() - startMs }, 'Bulk scoring complete (unscored agents)');
    }

    // Phase 2: Rescore already-scored agents (refresh with latest data)
    const alreadyScored = agentRepo.findScoredAgents();
    if (alreadyScored.length > 0) {
      const rescoreStart = Date.now();
      const rescored = await scoreBatch(alreadyScored, scoringService, 'rescore');
      logger.info({ rescored, total: alreadyScored.length, durationMs: Date.now() - rescoreStart }, 'Bulk rescore complete (existing agents)');
    }

    const purged = await snapshotRepo.purgeOldSnapshots();
    if (purged > 0) {
      logger.info({ purged }, 'Old snapshots purged');
    }

    logger.info({ totalDurationMs: Date.now() - startMs }, 'Bulk scoring pipeline finished');
  } finally {
    lock.release();
  }
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
  nostrPublishFn?: () => Promise<void>,
): Promise<void> {
  await crawlObserver(observerCrawler);
  await crawlLightning(lndGraphCrawler, mempoolCrawler);

  // Score immediately after LND crawl — don't wait for LN+ or probes
  await bulkScoreAll(agentRepo, scoringService, snapshotRepo);

  // Publish scores to Nostr right after scoring — before LN+ (2.5h) and probes (35min).
  // SKIP_INITIAL_NOSTR_PUBLISH short-circuits the initial publish (can block the
  // boot-time arming of per-source timers by ~25min on prod with 4k+ scores).
  // The periodic NostrPublisher timer still runs and will publish on its next
  // cycle — this escape hatch only affects the kick-at-boot pass.
  if (nostrPublishFn) {
    if (process.env.SKIP_INITIAL_NOSTR_PUBLISH === 'true') {
      logger.info('Initial Nostr publish skipped (SKIP_INITIAL_NOSTR_PUBLISH=true)');
    } else {
      try {
        await nostrPublishFn();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ error: msg }, 'Nostr publish in runFullCrawl failed');
      }
    }
  }

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
  await bulkScoreAll(agentRepo, scoringService, snapshotRepo);
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
  const channelSnapshotRepo = new ChannelSnapshotRepository(db);
  const feeSnapshotRepo = new FeeSnapshotRepository(db);

  const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo, channelSnapshotRepo, feeSnapshotRepo);

  const observerClient = new HttpObserverClient({
    baseUrl: config.OBSERVER_BASE_URL,
    timeoutMs: config.OBSERVER_TIMEOUT_MS,
  });
  // Phase 1 shadow-mode rollout: construct the NDJSON logger only when
  // dry_run is active. In `off` and `active` modes the logger is silent by
  // contract, so skipping construction saves a filesystem mkdir + open on
  // every crawler process boot (and avoids WARN noise on dev laptops that
  // lack the /var/log/satrank mount).
  const dualWriteLogger = config.TRANSACTIONS_DUAL_WRITE_MODE === 'dry_run'
    ? new DualWriteLogger(config.TRANSACTIONS_DRY_RUN_LOG_PATH)
    : undefined;
  const observerCrawler = new Crawler(
    observerClient,
    agentRepo,
    txRepo,
    config.TRANSACTIONS_DUAL_WRITE_MODE,
    dualWriteLogger,
  );

  const lndClient = new HttpLndGraphClient({
    restUrl: config.LND_REST_URL,
    macaroonPath: config.LND_MACAROON_PATH,
    timeoutMs: config.LND_TIMEOUT_MS,
  });
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

    // Start the liveness heartbeat FIRST — the initial runFullCrawl below
    // can take many minutes and the docker healthcheck must see a fresh
    // mtime throughout. setInterval still fires as long as the event loop
    // is responsive, which is exactly what we want to detect.
    touchHeartbeat();
    const timerHeartbeat = setInterval(touchHeartbeat, HEARTBEAT_INTERVAL_MS);
    logger.info({ path: HEARTBEAT_PATH, intervalMs: HEARTBEAT_INTERVAL_MS }, 'Liveness heartbeat started');

    // /metrics endpoint for Prometheus. Bound on the docker network so the
    // host can reach it via the published port; auth is localhost OR X-API-Key.
    // Cron-only: one-shot mode exits on completion and shouldn't hold a socket.
    const metricsServer = startCrawlerMetricsServer({ port: config.CRAWLER_METRICS_PORT });

    // Nostr publisher — init before runFullCrawl so it publishes right after bulk scoring
    let nostrPublishFn: (() => Promise<void>) | undefined;
    let timerNostr: ReturnType<typeof setInterval> | null = null;
    let timerZapMining: ReturnType<typeof setInterval> | null = null;
    logger.info({ hasKey: !!config.NOSTR_PRIVATE_KEY, keyLen: config.NOSTR_PRIVATE_KEY?.length ?? 0 }, 'Nostr publisher check');
    if (config.NOSTR_PRIVATE_KEY) {
      logger.info('Nostr private key found — loading publisher module');
      try {
        const { NostrPublisher } = await import('../nostr/publisher');
        logger.info('Nostr publisher module loaded successfully');
        const survivalService = new SurvivalService(agentRepo, probeRepo, snapshotRepo);
        const nostrRelays = config.NOSTR_RELAYS.split(',').map(r => r.trim());
        const nostrPublisher = new NostrPublisher(agentRepo, probeRepo, snapshotRepo, scoringService, survivalService, {
          privateKeyHex: config.NOSTR_PRIVATE_KEY,
          relays: nostrRelays,
          minScore: config.NOSTR_MIN_SCORE,
        });

        // Stream B — zap-receipt mining + nostr-indexed publishing
        const mappingsPath = join(dirname(config.DB_PATH), 'nostr-mappings.json');
        const { ZapMiner } = await import('../nostr/zapMiner');
        const zapMiner = new ZapMiner({
          relays: config.ZAP_MINING_RELAYS.split(',').map(r => r.trim()),
          pageSize: config.ZAP_MINING_PAGE_SIZE,
          maxPages: config.ZAP_MINING_MAX_PAGES,
          maxAgeDays: 90,
          minPageYield: 20,
          pageTimeoutMs: 15_000,
          custodialThreshold: config.ZAP_CUSTODIAL_THRESHOLD,
          outputPath: mappingsPath,
        });

        const { NostrIndexedPublisher } = await import('../nostr/nostrIndexedPublisher');
        const nostrIndexedPublisher = new NostrIndexedPublisher(agentRepo, snapshotRepo, {
          privateKeyHex: config.NOSTR_PRIVATE_KEY,
          relays: nostrRelays,
          minScore: config.NOSTR_MIN_SCORE,
          mappingsPath,
        });

        // Dual publish function: Stream A (lightning-indexed) then Stream B (nostr-indexed)
        nostrPublishFn = async () => {
          logger.info('Starting Nostr publish — Stream A (lightning-indexed)');
          const resultA = await nostrPublisher.publishScores();
          logger.info({ published: resultA.published, skipped: resultA.skipped, total: resultA.total, errors: resultA.errors }, 'Stream A complete');

          logger.info('Starting Nostr publish — Stream B (nostr-indexed)');
          const resultB = await nostrIndexedPublisher.publishFromMiningJson();
          logger.info({ published: resultB.published, errors: resultB.errors, dropped: resultB.dropped }, 'Stream B complete');
        };

        timerNostr = setInterval(() => {
          logger.info('Nostr cron publish triggered');
          nostrPublisher.publishScores()
            .then(resultA => {
              logger.info({ published: resultA.published, skipped: resultA.skipped, total: resultA.total, errors: resultA.errors }, 'Stream A cron complete');
              return nostrIndexedPublisher.publishFromMiningJson();
            })
            .then(resultB => {
              logger.info({ published: resultB.published, errors: resultB.errors, dropped: resultB.dropped }, 'Stream B cron complete');
            })
            .catch(err => logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Nostr cron publish error'));
        }, config.NOSTR_PUBLISH_INTERVAL_MS);
        logger.info({ intervalMs: config.NOSTR_PUBLISH_INTERVAL_MS, relays: config.NOSTR_RELAYS }, 'Nostr publisher started');

        // Initial zap mining — produces the JSON that Stream B needs.
        // Runs before the first crawl so the publish cycle has data.
        try {
          const miningResult = await zapMiner.mine();
          logger.info(miningResult, 'Initial zap mining complete');
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ error: msg }, 'Initial zap mining failed — Stream B will use stale JSON if available');
        }

        // Daily zap mining timer — mappings change slowly (weeks), no need to mine every 6h
        timerZapMining = setInterval(() => {
          logger.info('Zap mining cron triggered');
          zapMiner.mine()
            .then(result => logger.info(result, 'Zap mining cron complete'))
            .catch(err => logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Zap mining cron error'));
        }, config.ZAP_MINING_INTERVAL_MS);
        timerZapMining.unref?.();
        logger.info({ intervalMs: config.ZAP_MINING_INTERVAL_MS }, 'Zap mining cron timer started');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : '';
        logger.error({ error: msg, stack }, 'Failed to load Nostr publisher');
      }
      // Start DVM (NIP-90) — listens for trust-check job requests in background
      try {
        const { SatRankDvm } = await import('../nostr/dvm');
        const dvm = new SatRankDvm(agentRepo, probeRepo, snapshotRepo, scoringService,
          lndClient.isConfigured() ? lndClient : undefined, {
            privateKeyHex: config.NOSTR_PRIVATE_KEY,
            relays: config.NOSTR_RELAYS.split(',').map(r => r.trim()),
          });
        await dvm.start();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ error: msg }, 'Failed to start DVM');
      }
    } else {
      logger.info('Nostr publisher disabled — NOSTR_PRIVATE_KEY not set');
    }

    // Run an initial stale sweep so the DB reflects fossils before the first crawl fires
    runStaleSweep(agentRepo);

    // Retention cleanup — sweep old rows from time-series tables
    // (probe_results, score_snapshots, channel_snapshots, fee_snapshots)
    // before the first crawl so we start with a trimmed dataset.
    try {
      await runRetentionCleanup(db);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg }, 'Initial retention cleanup failed');
    }

    // Initial full crawl — Nostr publish happens inside, right after bulk scoring
    await runFullCrawl(
      observerCrawler, lndGraphCrawlerInstance, mempoolCrawlerInstance,
      lnplusCrawlerInstance, probeCrawlerInstance, probeRepo, agentRepo, scoringService, snapshotRepo,
      nostrPublishFn,
    );

    // Post-crawl sweep: any agent not touched during the graph crawl whose last_seen is > 90d
    // will now be flagged. Agents that were seen had their stale reset to 0 by the crawler updates.
    runStaleSweep(agentRepo);

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
      let probeRunning = false;
      timerProbe = setInterval(() => {
        if (probeRunning) return; // skip if previous cycle still running
        probeRunning = true;
        crawlProbe(probeCrawlerInstance, probeRepo)
          .catch(err => logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Probe crawl error'))
          .finally(() => { probeRunning = false; });
      }, intervals.probe);
      logger.info({ intervalMs: intervals.probe }, 'Probe cron timer started');
    } else {
      logger.warn('Probe cron timer NOT started — LND not configured');
    }

    // Service health crawler — periodic HTTP checks on known endpoints (every 5 min)
    const { ServiceHealthCrawler } = await import('./serviceHealthCrawler');
    const { ServiceEndpointRepository } = await import('../repositories/serviceEndpointRepository');
    const serviceEndpointRepo = new ServiceEndpointRepository(db);
    const serviceHealthCrawler = new ServiceHealthCrawler(
      serviceEndpointRepo,
      txRepo,
      config.TRANSACTIONS_DUAL_WRITE_MODE,
      dualWriteLogger,
    );
    const timerServiceHealth = setInterval(() => {
      serviceHealthCrawler.run()
        .catch(err => logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Service health crawl error'));
    }, 300_000); // 5 minutes
    timerServiceHealth.unref?.();
    logger.info({ intervalMs: 300_000 }, 'Service health crawler timer started');

    // Registry crawler — discovers L402 endpoints from 402index.io (every 24h)
    const { RegistryCrawler } = await import('./registryCrawler');
    const decodeBolt11 = lndClient.isConfigured() && lndClient.decodePayReq
      ? (invoice: string) => lndClient.decodePayReq!(invoice)
      : undefined;
    const registryCrawler = new RegistryCrawler(serviceEndpointRepo, decodeBolt11);
    const timerRegistry = setInterval(() => {
      registryCrawler.run()
        .catch(err => logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Registry crawl error'));
    }, config.CRAWL_INTERVAL_REGISTRY_MS);
    timerRegistry.unref?.();
    logger.info({ intervalMs: config.CRAWL_INTERVAL_REGISTRY_MS }, 'Registry crawler timer started');



    // Daily stale sweep — flags agents whose last_seen has fallen outside the 90-day window.
    const timerStaleSweep = setInterval(() => runStaleSweep(agentRepo), STALE_SWEEP_INTERVAL_MS);
    logger.info({ intervalMs: STALE_SWEEP_INTERVAL_MS, thresholdSec: STALE_THRESHOLD_SEC }, 'Stale sweep cron timer started');

    // Daily retention cleanup — sweeps old rows from time-series tables.
    // Fire-and-forget inside setInterval; .catch() logs without crashing
    // the cron loop if one sweep fails (next tick will retry).
    const timerRetention = setInterval(() => {
      runRetentionCleanup(db).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ error: msg }, 'Scheduled retention cleanup failed');
      });
    }, RETENTION_INTERVAL_MS);
    logger.info({ intervalMs: RETENTION_INTERVAL_MS }, 'Retention cleanup cron timer started');

    // WAL checkpoint cron — `wal_autocheckpoint = 1000` triggers opportunistic
    // checkpoints on writes, but under constant read pressure readers keep
    // snapshots open and the checkpoint never advances far enough to truncate.
    // We've seen the WAL grow past 1.6 GB in practice. A periodic
    // wal_checkpoint(TRUNCATE) reclaims disk and caps replay time on recovery.
    const WAL_CHECKPOINT_INTERVAL_MS = 60 * 60 * 1000; // 1h
    const timerWalCheckpoint = setInterval(() => {
      try {
        const result = db.pragma('wal_checkpoint(TRUNCATE)');
        logger.info({ result }, 'WAL checkpoint(TRUNCATE) complete');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ error: msg }, 'WAL checkpoint failed');
      }
    }, WAL_CHECKPOINT_INTERVAL_MS);
    timerWalCheckpoint.unref?.();
    logger.info({ intervalMs: WAL_CHECKPOINT_INTERVAL_MS }, 'WAL checkpoint cron timer started');

    function shutdown() {
      logger.info('Stopping cron crawler');
      clearInterval(timerHeartbeat);
      clearInterval(timerObserver);
      clearInterval(timerLnd);
      clearInterval(timerLnplus);
      if (timerProbe) clearInterval(timerProbe);
      if (timerNostr) clearInterval(timerNostr);
      if (timerZapMining) clearInterval(timerZapMining);
      clearInterval(timerStaleSweep);
      clearInterval(timerRetention);
      clearInterval(timerWalCheckpoint);
      metricsServer.close();
      closeDatabase();
      process.exit(0);
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } else {
    runStaleSweep(agentRepo);
    await runFullCrawl(
      observerCrawler, lndGraphCrawlerInstance, mempoolCrawlerInstance,
      lnplusCrawlerInstance, probeCrawlerInstance, probeRepo, agentRepo, scoringService, snapshotRepo,
    );
    runStaleSweep(agentRepo);
    closeDatabase();
  }
}

main().catch(err => {
  logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Fatal crawler error');
  closeDatabase();
  process.exit(1);
});
