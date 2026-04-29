// Crawler launch script — single run or cron mode with per-source intervals
// Usage: npm run crawl          (single run — all sources once)
//        npm run crawl -- --cron (per-source intervals, configurable)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config';
import { logger } from '../logger';
import { crawlDuration } from '../middleware/metrics';
import { startCrawlerMetricsServer } from './metricsServer';
import { getCrawlerPool, closePools } from '../database/connection';
import { runMigrations } from '../database/migrations';
import { acquireBulkRescoreLock } from '../utils/advisoryLock';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ScoringService } from '../services/scoringService';
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
import {
  EndpointStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
  OperatorStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  RouteStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import {
  EndpointDailyBucketsRepository,
  ServiceDailyBucketsRepository,
  OperatorDailyBucketsRepository,
  NodeDailyBucketsRepository,
  RouteDailyBucketsRepository,
} from '../repositories/dailyBucketsRepository';
import { BayesianScoringService } from '../services/bayesianScoringService';
import { BayesianVerdictService } from '../services/bayesianVerdictService';
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

  // Purge stale probe results — keep 60 days. Streaming τ=7j pondère déjà les
  // vieilles probes vers zéro, mais on conserve l'historique brut 60j pour le
  // rebuild streaming et l'audit. Storage ≈ 290k rows, acceptable SQLite.
  const purged = await probeRepo.purgeOlderThan(60 * 24 * 3600);
  if (purged > 0) {
    logger.info({ purged }, 'Old probe results purged');
  }
}

// Fossil sweep — agents not seen in this window are flagged stale=1.
// A sighting (graph crawl, probe, or graph update) restores stale=0 automatically.
const STALE_THRESHOLD_SEC = 90 * 86400; // 90 days
const STALE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

async function runStaleSweep(agentRepo: AgentRepository): Promise<void> {
  try {
    const flagged = await agentRepo.markStaleByAge(STALE_THRESHOLD_SEC);
    const total = await agentRepo.countStale();
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
async function scoreBatch(
  agents: { public_key_hash: string }[],
  scoringService: ScoringService,
  bayesianVerdict: BayesianVerdictService,
  label: string,
): Promise<number> {
  let scored = 0;
  let errors = 0;
  for (let i = 0; i < agents.length; i += SCORE_BATCH_SIZE) {
    const batch = agents.slice(i, i + SCORE_BATCH_SIZE);
    for (const agent of batch) {
      try {
        await scoringService.computeScore(agent.public_key_hash);
        // Phase 3 C8: snapshot persistence is now on the Bayesian side.
        // scoringService only maintains agents.avg_score; score_snapshots
        // receives the posterior (p_success, ci95, n_obs) from here.
        await bayesianVerdict.snapshotAndPersist(agent.public_key_hash);
        scored++;
      } catch (err: unknown) {
        errors++;
        if (errors <= 5) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ agentHash: agent.public_key_hash.slice(0, 12), error: msg }, `Scoring error (${label})`);
        }
      }
    }
    if (scored % 500 === 0 && scored > 0) {
      logger.info({ scored, total: agents.length, errors }, `Bulk scoring progress (${label})`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return scored;
}

// Lock path lives on the shared docker volume so both containers (and any
// manual script running inside either) see the same lock.
// Phase 12B : DB_PATH a disparu avec la migration Postgres — on reprend la
// même convention que app.ts (cf. commentaire Phase 12B : « npub-age cache
// est un fichier plain sous ./data »).
const STATE_DIR = join(process.cwd(), 'data');
const BULK_RESCORE_LOCK_PATH = join(STATE_DIR, '.bulk-rescore.lock');

async function bulkScoreAll(
  agentRepo: AgentRepository,
  scoringService: ScoringService,
  bayesianVerdict: BayesianVerdictService,
  snapshotRepo: SnapshotRepository,
): Promise<void> {
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
    const unscoredCount = await agentRepo.countUnscoredWithData();
    logger.info({ unscoredCount }, 'Starting bulk scoring: unscored agents with data');

    if (unscoredCount > 0) {
      const unscored = await agentRepo.findUnscoredWithData();
      const scored = await scoreBatch(unscored, scoringService, bayesianVerdict, 'unscored');
      logger.info({ scored, total: unscored.length, durationMs: Date.now() - startMs }, 'Bulk scoring complete (unscored agents)');
    }

    const alreadyScored = await agentRepo.findScoredAgents();
    if (alreadyScored.length > 0) {
      const rescoreStart = Date.now();
      const rescored = await scoreBatch(alreadyScored, scoringService, bayesianVerdict, 'rescore');
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
  lndGraphCrawler: LndGraphCrawler,
  mempoolCrawler: MempoolCrawler,
  lnplusCrawler: LnplusCrawler,
  probeCrawlerInstance: ProbeCrawler | null,
  probeRepo: ProbeRepository,
  agentRepo: AgentRepository,
  scoringService: ScoringService,
  bayesianVerdict: BayesianVerdictService,
  snapshotRepo: SnapshotRepository,
  nostrPublishFn?: () => Promise<void>,
): Promise<void> {
  await crawlLightning(lndGraphCrawler, mempoolCrawler);

  // Score immediately after LND crawl — don't wait for LN+ or probes
  await bulkScoreAll(agentRepo, scoringService, bayesianVerdict, snapshotRepo);

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
  await bulkScoreAll(agentRepo, scoringService, bayesianVerdict, snapshotRepo);
}

// --- Main ---

async function main(): Promise<void> {
  const pool = getCrawlerPool();
  await runMigrations(pool);

  const agentRepo = new AgentRepository(pool);
  const txRepo = new TransactionRepository(pool);
  const attestationRepo = new AttestationRepository(pool);
  const snapshotRepo = new SnapshotRepository(pool);
  const probeRepo = new ProbeRepository(pool);
  const channelSnapshotRepo = new ChannelSnapshotRepository(pool);
  const feeSnapshotRepo = new FeeSnapshotRepository(pool);

  const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, pool, probeRepo, channelSnapshotRepo, feeSnapshotRepo);

  // Phase 3 C8: crawler-side BayesianVerdictService owns snapshot persistence.
  // Les streaming/buckets repos sont mutualisés avec l'app — même schéma, même
  // pool, la cascade hiérarchique lit les mêmes tables côté read et write.
  const endpointStreamingMain = new EndpointStreamingPosteriorRepository(pool);
  const endpointBucketsMain = new EndpointDailyBucketsRepository(pool);
  const bayesianScoringServiceMain = new BayesianScoringService(
    endpointStreamingMain,
    new ServiceStreamingPosteriorRepository(pool),
    new OperatorStreamingPosteriorRepository(pool),
    new NodeStreamingPosteriorRepository(pool),
    new RouteStreamingPosteriorRepository(pool),
    endpointBucketsMain,
    new ServiceDailyBucketsRepository(pool),
    new OperatorDailyBucketsRepository(pool),
    new NodeDailyBucketsRepository(pool),
    new RouteDailyBucketsRepository(pool),
  );
  const bayesianVerdictServiceMain = new BayesianVerdictService(
    bayesianScoringServiceMain, endpointStreamingMain, endpointBucketsMain, snapshotRepo,
  );

  // Phase 1 shadow-mode rollout: construct the NDJSON logger only when
  // dry_run is active. In `off` and `active` modes the logger is silent by
  // contract, so skipping construction saves a filesystem mkdir + open on
  // every crawler process boot (and avoids WARN noise on dev laptops that
  // lack the /var/log/satrank mount).
  const dualWriteLogger = config.TRANSACTIONS_DUAL_WRITE_MODE === 'dry_run'
    ? new DualWriteLogger(config.TRANSACTIONS_DRY_RUN_LOG_PATH)
    : undefined;

  const lndClient = new HttpLndGraphClient({
    restUrl: config.LND_REST_URL,
    macaroonPath: config.LND_MACAROON_PATH,
    timeoutMs: config.LND_TIMEOUT_MS,
    // Sim 7 follow-up — paid-probe stages 3-5 require off-chain payments.
    // Same probe-pay.macaroon as the api container (offchain:read +
    // offchain:write, no channel/onchain). When unset, paidProbeRunner
    // returns skipped_no_lnd for every probe and stages 3-5 stay empty.
    adminMacaroonPath: config.LND_ADMIN_MACAROON_PATH,
  });
  const lndGraphCrawlerInstance = new LndGraphCrawler(lndClient, agentRepo, channelSnapshotRepo, feeSnapshotRepo);

  const mempoolClient = new HttpMempoolClient();
  const mempoolCrawlerInstance = new MempoolCrawler(mempoolClient, agentRepo);

  const lnplusClient = new HttpLnplusClient();
  const lnplusCrawlerInstance = new LnplusCrawler(lnplusClient, agentRepo);

  const probeCrawlerInstance = lndClient.isConfigured()
    ? new ProbeCrawler(
        lndClient, agentRepo, probeRepo,
        {
          maxPerSecond: config.PROBE_MAX_PER_SECOND,
          amountSats: config.PROBE_AMOUNT_SATS,
          dualWriteMode: config.TRANSACTIONS_DUAL_WRITE_MODE,
        },
        {
          txRepo,
          bayesian: bayesianScoringServiceMain,
          pool,
          dualWriteLogger,
        },
      )
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
      lndGraph: config.CRAWL_INTERVAL_LND_GRAPH_MS,
      lnplus: config.CRAWL_INTERVAL_LNPLUS_MS,
      probe: config.CRAWL_INTERVAL_PROBE_MS,
    };

    logger.info({
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
        // Bayesian verdict service — C10 branchement dans le pipeline Nostr :
        // les tags publiés sont 100 % bayésiens (plus de composite legacy).
        const endpointStreamingNostr = new EndpointStreamingPosteriorRepository(pool);
        const endpointBucketsNostr = new EndpointDailyBucketsRepository(pool);
        const bayesianScoringServiceNostr = new BayesianScoringService(
          endpointStreamingNostr,
          new ServiceStreamingPosteriorRepository(pool),
          new OperatorStreamingPosteriorRepository(pool),
          new NodeStreamingPosteriorRepository(pool),
          new RouteStreamingPosteriorRepository(pool),
          endpointBucketsNostr,
          new ServiceDailyBucketsRepository(pool),
          new OperatorDailyBucketsRepository(pool),
          new NodeDailyBucketsRepository(pool),
          new RouteDailyBucketsRepository(pool),
        );
        const bayesianVerdictServiceNostr = new BayesianVerdictService(
          bayesianScoringServiceNostr, endpointStreamingNostr, endpointBucketsNostr,
        );
        const nostrRelays = config.NOSTR_RELAYS.split(',').map(r => r.trim());
        const nostrPublisher = new NostrPublisher(
          agentRepo,
          probeRepo,
          snapshotRepo,
          scoringService,
          survivalService,
          bayesianVerdictServiceNostr,
          {
            privateKeyHex: config.NOSTR_PRIVATE_KEY,
            relays: nostrRelays,
            minScore: config.NOSTR_MIN_SCORE,
          },
        );

        // Stream B — zap-receipt mining + nostr-indexed publishing.
        // Phase 12B : fichier plain sous ./data (même convention que app.ts).
        const mappingsPath = join(STATE_DIR, 'nostr-mappings.json');
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
      // Start DVM (NIP-90) — listens for trust-check job requests in background.
      // DVM publishes the canonical Bayesian block as its kind 6900 payload;
      // spin up its own BayesianVerdictService instance since the one above
      // lives inside the Nostr-publisher try-block scope.
      try {
        const { SatRankDvm } = await import('../nostr/dvm');
        const endpointStreamingDvm = new EndpointStreamingPosteriorRepository(pool);
        const serviceStreamingDvm = new ServiceStreamingPosteriorRepository(pool);
        const operatorStreamingDvm = new OperatorStreamingPosteriorRepository(pool);
        const nodeStreamingDvm = new NodeStreamingPosteriorRepository(pool);
        const routeStreamingDvm = new RouteStreamingPosteriorRepository(pool);
        const endpointBucketsDvm = new EndpointDailyBucketsRepository(pool);
        const serviceBucketsDvm = new ServiceDailyBucketsRepository(pool);
        const operatorBucketsDvm = new OperatorDailyBucketsRepository(pool);
        const nodeBucketsDvm = new NodeDailyBucketsRepository(pool);
        const routeBucketsDvm = new RouteDailyBucketsRepository(pool);
        const bayesianScoringServiceDvm = new BayesianScoringService(
          endpointStreamingDvm,
          serviceStreamingDvm,
          operatorStreamingDvm,
          nodeStreamingDvm,
          routeStreamingDvm,
          endpointBucketsDvm,
          serviceBucketsDvm,
          operatorBucketsDvm,
          nodeBucketsDvm,
          routeBucketsDvm,
        );
        const bayesianVerdictServiceDvm = new BayesianVerdictService(
          bayesianScoringServiceDvm, endpointStreamingDvm, endpointBucketsDvm,
        );
        const dvm = new SatRankDvm(agentRepo, probeRepo, bayesianVerdictServiceDvm,
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

    // Phase 8 — C5 : scheduler multi-kind (30382/30383) indépendant du legacy
    // NIP-85 single-source. Gated OFF par défaut tant que Checkpoint 2 n'est
    // pas validé en prod. Cron 5 min : scan les posteriors modifiés, shouldRepublish,
    // publish, update cache.
    let timerNostrMultiKind: ReturnType<typeof setInterval> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let multiKindPublisherRef: any = null;
    if (config.NOSTR_MULTI_KIND_ENABLED && config.NOSTR_PRIVATE_KEY) {
      try {
        const { NostrMultiKindPublisher } = await import('../nostr/nostrMultiKindPublisher');
        const { NostrMultiKindScheduler } = await import('../nostr/nostrMultiKindScheduler');
        const { NostrPublishedEventsRepository } = await import('../repositories/nostrPublishedEventsRepository');
        const { ServiceEndpointRepository } = await import('../repositories/serviceEndpointRepository');
        const { OperatorService } = await import('../services/operatorService');
        const {
          OperatorRepository,
          OperatorIdentityRepository,
          OperatorOwnershipRepository,
        } = await import('../repositories/operatorRepository');

        const multiKindRelays = config.NOSTR_RELAYS.split(',').map((r) => r.trim());
        const multiKindPublisher = new NostrMultiKindPublisher({
          privateKeyHex: config.NOSTR_PRIVATE_KEY,
          relays: multiKindRelays,
        });
        multiKindPublisherRef = multiKindPublisher;

        const endpointStreamingMulti = new EndpointStreamingPosteriorRepository(pool);
        const nodeStreamingMulti = new NodeStreamingPosteriorRepository(pool);
        const serviceStreamingMulti = new ServiceStreamingPosteriorRepository(pool);
        const publishedEventsRepo = new NostrPublishedEventsRepository(pool);
        const serviceEndpointRepoMulti = new ServiceEndpointRepository(pool);
        const operatorService = new OperatorService(
          new OperatorRepository(pool),
          new OperatorIdentityRepository(pool),
          new OperatorOwnershipRepository(pool),
          endpointStreamingMulti,
          nodeStreamingMulti,
          serviceStreamingMulti,
        );

        const multiKindScheduler = new NostrMultiKindScheduler(
          multiKindPublisher,
          endpointStreamingMulti,
          nodeStreamingMulti,
          publishedEventsRepo,
          serviceEndpointRepoMulti,
          operatorService,
          pool,
        );

        const runMultiKindScan = (): void => {
          const now = Math.floor(Date.now() / 1000);
          multiKindScheduler
            .runScan(now, {
              scanWindowSec: config.NOSTR_MULTI_KIND_SCAN_WINDOW_SEC,
              maxPerType: config.NOSTR_MULTI_KIND_MAX_PER_TYPE,
            })
            .then((result) => {
              for (const r of result.perType) {
                logger.info(
                  {
                    entityType: r.entityType,
                    scanned: r.scanned,
                    published: r.published,
                    firstPublish: r.firstPublish,
                    skippedNoChange: r.skippedNoChange,
                    errors: r.errors,
                  },
                  'nostr multi-kind scan result',
                );
              }
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              logger.error({ error: msg }, 'nostr multi-kind scan error');
            });
        };

        timerNostrMultiKind = setInterval(runMultiKindScan, config.NOSTR_MULTI_KIND_INTERVAL_MS);
        timerNostrMultiKind.unref?.();
        logger.info(
          {
            intervalMs: config.NOSTR_MULTI_KIND_INTERVAL_MS,
            scanWindowSec: config.NOSTR_MULTI_KIND_SCAN_WINDOW_SEC,
            maxPerType: config.NOSTR_MULTI_KIND_MAX_PER_TYPE,
            relays: multiKindRelays,
          },
          'Nostr multi-kind scheduler started',
        );

        // Phase 5.15 — calibration moat. Cron weekly qui calcule
        // |p_predicted - p_observed| sur la fenêtre 7d et publie un
        // kind 30783 signé. Réutilise le multiKindPublisher (déjà connecté
        // aux 3 relais SatRank avec NOSTR_PRIVATE_KEY).
        const { CalibrationRepository } = await import('../repositories/calibrationRepository');
        const { CalibrationService } = await import('../services/calibrationService');
        const { CalibrationPublisher } = await import('../services/calibrationPublisher');
        // @ts-expect-error — moduleResolution "node" can't resolve ESM subpath
        const { getPublicKey } = await import('nostr-tools/pure');
        const { hexToBytes } = await import('@noble/hashes/utils');
        const oraclePubkey = getPublicKey(hexToBytes(config.NOSTR_PRIVATE_KEY)) as string;
        const calibRepo = new CalibrationRepository(pool);
        const calibService = new CalibrationService(calibRepo);
        const calibPublisher = new CalibrationPublisher({
          service: calibService,
          repo: calibRepo,
          publisher: multiKindPublisher,
          oraclePubkey,
        });
        const runCalibration = (): void => {
          calibPublisher
            .publishCycle()
            .then((res) => {
              if (res === null) {
                logger.info('Calibration cron: skipped (recent run exists)');
                return;
              }
              logger.info(
                {
                  eventId: res.eventId?.slice(0, 12),
                  n_endpoints: res.result.n_endpoints,
                  n_outcomes: res.result.n_outcomes,
                  delta_mean: res.result.delta_mean,
                  delta_p95: res.result.delta_p95,
                },
                'Calibration cron tick complete (kind 30783 published)',
              );
            })
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              logger.error({ error: msg }, 'Calibration cron error');
            });
        };
        // Initial firing après 1h (le boot a besoin de stabilité avant de
        // cogner le DB pour scanner le log).
        const calibInitialDelay = 60 * 60 * 1000;
        const calibIntervalMs = 7 * 24 * 60 * 60 * 1000; // weekly
        const initialTimer = setTimeout(() => {
          runCalibration();
          const recurrent = setInterval(runCalibration, calibIntervalMs);
          recurrent.unref?.();
        }, calibInitialDelay);
        initialTimer.unref?.();
        logger.info(
          { initialDelayMs: calibInitialDelay, intervalMs: calibIntervalMs },
          'Phase 5.15 — Calibration cron scheduled (kind 30783 weekly)',
        );

        // Phase 6.2 — kind 30782 trust assertions cron. Pour chaque endpoint
        // avec stage_posteriors meaningful, publish un event NIP-33
        // addressable replaceable. Permet aux agents Nostr-natifs +
        // verify_assertion (Phase 6.0) de composer offline.
        const { TrustAssertionPublisher } = await import('../services/trustAssertionPublisher');
        const { TrustAssertionRepository } = await import('../repositories/trustAssertionRepository');
        const { EndpointStagePosteriorsRepository: StageRepoCtor } = await import('../repositories/endpointStagePosteriorsRepository');
        const trustRepo = new TrustAssertionRepository(pool);
        const stagePosteriorsRepoForTrust = new StageRepoCtor(pool);
        const trustPublisher = new TrustAssertionPublisher({
          serviceEndpointRepo: serviceEndpointRepoMulti,
          stagePosteriorsRepo: stagePosteriorsRepoForTrust,
          calibrationRepo: calibRepo,
          trustAssertionRepo: trustRepo,
          publisher: multiKindPublisher,
          oraclePubkey,
          relays: multiKindRelays,
        });
        const runTrustAssertions = (): void => {
          trustPublisher
            .publishCycle()
            .then((res) => {
              logger.info(
                {
                  published: res.outcomes.published,
                  skipped_recent: res.outcomes.skipped_recent,
                  skipped_no_meaningful: res.outcomes.skipped_no_meaningful,
                  publish_failed: res.outcomes.publish_failed,
                  duration_sec: res.cycle_finished_at - res.cycle_started_at,
                },
                'Trust assertion cron tick complete (kind 30782)',
              );
            })
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              logger.error({ error: msg }, 'Trust assertion cron error');
            });
        };
        // Initial fire 90 min après boot (après calibration), puis weekly.
        const trustInitialDelay = 90 * 60 * 1000;
        const trustIntervalMs = 7 * 24 * 60 * 60 * 1000;
        const trustInitialTimer = setTimeout(() => {
          runTrustAssertions();
          const recurrent = setInterval(runTrustAssertions, trustIntervalMs);
          recurrent.unref?.();
        }, trustInitialDelay);
        trustInitialTimer.unref?.();
        logger.info(
          { initialDelayMs: trustInitialDelay, intervalMs: trustIntervalMs },
          'Phase 6.2 — Trust assertion cron scheduled (kind 30782 weekly)',
        );

        // Sim 7 follow-up — paid-probe cron for stages 3-5 (payment /
        // delivery / quality). Pays N L402 invoices per cycle on the hot
        // tier, populating the per-stage Beta posteriors used by
        // /api/intent's stage_posteriors block. Conservative caps: 5
        // sats/probe × 10 probes × 4 cycles/day = ~200 sats/day max.
        // OPT-IN via PAID_PROBE_ENABLED=true. Self-pay skip via the LND
        // identity_pubkey we already fetched for the announcement cron.
        if (config.PAID_PROBE_ENABLED) {
          const { PaidProbeRunner } = await import('../services/paidProbeRunner');
          const { OracleBudgetService } = await import('../services/oracleBudgetService');
          const oracleBudgetSvc = new OracleBudgetService(pool);
          // Re-use lndPubkeyLocal from the announcement-cron block below
          // by deferring the runner wiring there. We only need to fetch
          // it once, so the construction runs after the announcement
          // cron's getInfo() call has populated lndPubkeyLocal.
          // (See block immediately following.)
          // The runner itself is constructed lazily inside the cron tick
          // so a transient LND outage at boot doesn't kill the whole
          // crawler; instead the cron logs and skips.
          let paidProbeRunnerSingleton: InstanceType<typeof PaidProbeRunner> | null = null;
          let paidProbeSelfPubkey: string | null = null;
          const ensurePaidProbeRunner = async (): Promise<{
            runner: InstanceType<typeof PaidProbeRunner>;
            selfPubkey: string;
          } | null> => {
            if (paidProbeRunnerSingleton && paidProbeSelfPubkey) {
              return { runner: paidProbeRunnerSingleton, selfPubkey: paidProbeSelfPubkey };
            }
            try {
              if (!lndClient.isConfigured() || !lndClient.getInfo) {
                logger.warn('Paid probe cron skipped tick — LND client not configured');
                return null;
              }
              const info = await lndClient.getInfo();
              const pubkey = info?.identity_pubkey;
              if (!pubkey || pubkey.length !== 66) {
                logger.warn({ identity_pubkey: pubkey }, 'Paid probe cron skipped tick — invalid LND pubkey');
                return null;
              }
              paidProbeSelfPubkey = pubkey;
              paidProbeRunnerSingleton = new PaidProbeRunner({
                stagesRepo: stagePosteriorsRepoForTrust,
                lndClient,
              });
              return { runner: paidProbeRunnerSingleton, selfPubkey: pubkey };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              logger.warn({ error: msg }, 'Paid probe cron skipped tick — getInfo() failed');
              return null;
            }
          };
          const runPaidProbe = async (): Promise<void> => {
            try {
              const ready = await ensurePaidProbeRunner();
              if (!ready) return;
              const hot = await serviceEndpointRepoMulti.findStaleByTier('hot', config.PAID_PROBE_MAX_PER_CYCLE);
              if (hot.length === 0) {
                logger.info('Paid probe cycle: no hot endpoints stale — skipped');
                return;
              }
              const summary = await ready.runner.runOnce({
                endpoint_urls: hot.map((e) => e.url),
                maxPerProbeSats: config.PAID_PROBE_MAX_PER_PROBE_SATS,
                totalBudgetSats: config.PAID_PROBE_TOTAL_BUDGET_SATS,
                maxProbesPerCycle: config.PAID_PROBE_MAX_PER_CYCLE,
                selfPubkey: ready.selfPubkey,
              });
              if (summary.totalSpent > 0) {
                await oracleBudgetSvc.logSpending('paid_probe', summary.totalSpent, {
                  outcomes: summary.outcomes,
                  delivery: summary.deliveryOutcomes,
                  quality: summary.qualityOutcomes,
                  n_endpoints: hot.length,
                });
              }
              logger.info(
                {
                  n: hot.length,
                  spent: summary.totalSpent,
                  outcomes: summary.outcomes,
                  delivery: summary.deliveryOutcomes,
                  quality: summary.qualityOutcomes,
                },
                'Paid probe cycle complete (stages 3-5)',
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              logger.error({ error: msg }, 'Paid probe cron error');
            }
          };
          // Initial fire 30 min after boot (gives the api a chance to
          // populate any startup state), then PAID_PROBE_INTERVAL_HOURS.
          const paidInitialDelay = 30 * 60 * 1000;
          const paidIntervalMs = config.PAID_PROBE_INTERVAL_HOURS * 60 * 60 * 1000;
          const paidInitialTimer = setTimeout(() => {
            runPaidProbe();
            const recurrent = setInterval(runPaidProbe, paidIntervalMs);
            recurrent.unref?.();
          }, paidInitialDelay);
          paidInitialTimer.unref?.();
          logger.info(
            {
              initialDelayMs: paidInitialDelay,
              intervalMs: paidIntervalMs,
              maxPerProbeSats: config.PAID_PROBE_MAX_PER_PROBE_SATS,
              totalBudgetSats: config.PAID_PROBE_TOTAL_BUDGET_SATS,
              maxProbesPerCycle: config.PAID_PROBE_MAX_PER_CYCLE,
            },
            'Sim 7 follow-up — Paid probe cron scheduled (stages 3-5)',
          );
        } else {
          logger.info(
            'Paid probe cron disabled (PAID_PROBE_ENABLED=false) — stages 3-5 stay empty until enabled or until crowd outcomes flow',
          );
        }

        // Phase 7.0 — kind 30784 oracle announcement cron. Annonce CETTE
        // instance comme oracle SatRank-compatible aux autres clients +
        // peers. Cadence 24h pour la réactivité discovery.
        const { OracleAnnouncementPublisher, ANNOUNCEMENT_INTERVAL_MS } = await import('../services/oracleAnnouncementPublisher');
        const { OracleAnnouncementRepository } = await import('../repositories/oracleFederationRepository');
        const announcementRepo = new OracleAnnouncementRepository(pool);
        // LND pubkey local — best-effort. Si LND pas configuré, on annonce
        // sans (les clients downstream peuvent se passer de la vérif
        // sovereign LND).
        let lndPubkeyLocal: string | undefined;
        try {
          if (lndClient.isConfigured() && lndClient.getInfo) {
            const info = await lndClient.getInfo();
            lndPubkeyLocal = info?.identity_pubkey;
          }
        } catch {
          /* swallow — annoncement publish without lnd_pubkey */
        }
        const announcementPublisher = new OracleAnnouncementPublisher({
          serviceEndpointRepo: serviceEndpointRepoMulti,
          calibrationRepo: calibRepo,
          announcementRepo,
          publisher: multiKindPublisher,
          oraclePubkey,
          lndPubkey: lndPubkeyLocal,
          relays: multiKindRelays,
        });
        const runAnnouncement = (): void => {
          announcementPublisher
            .publishCycle()
            .then((res) => {
              if (res === null) return;
              logger.info(
                { eventId: res.event_id.slice(0, 12), catalogueSize: res.catalogue_size },
                'Oracle announcement cron tick complete (kind 30784)',
              );
            })
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              logger.error({ error: msg }, 'Oracle announcement cron error');
            });
        };
        // Initial fire 2h après boot, puis 24h.
        const announceInitialDelay = 2 * 60 * 60 * 1000;
        const announceIntervalMs = ANNOUNCEMENT_INTERVAL_MS;
        const announceTimer = setTimeout(() => {
          runAnnouncement();
          const recurrent = setInterval(runAnnouncement, announceIntervalMs);
          recurrent.unref?.();
        }, announceInitialDelay);
        announceTimer.unref?.();
        logger.info(
          { initialDelayMs: announceInitialDelay, intervalMs: announceIntervalMs },
          'Phase 7.0 — Oracle announcement cron scheduled (kind 30784 daily)',
        );

        // Phase 8.0 — subscribe permanent kind 30784. Ingère les
        // announcements d'autres oracles SatRank-compatible. Self-bootstrap :
        // notre propre announcement (republished 24h) revient sur la
        // subscription et nous-mêmes apparaissons dans oracle_peers.
        const { OraclePeerRepository } = await import('../repositories/oracleFederationRepository');
        const { OraclePeersDiscovery } = await import('../services/oraclePeersDiscovery');
        const { NostrEventSubscriber } = await import('../nostr/nostrEventSubscriber');
        // @ts-expect-error — moduleResolution "node" can't resolve ESM subpath
        const { verifyEvent: verifyEventFn } = await import('nostr-tools/pure');
        const oraclePeerRepo = new OraclePeerRepository(pool);
        const peersDiscovery = new OraclePeersDiscovery({
          peerRepo: oraclePeerRepo,
          verifyEvent: (event) => verifyEventFn(event as unknown as Parameters<typeof verifyEventFn>[0]),
        });
        const peersSubscriber = new NostrEventSubscriber({
          label: 'oracle-peers',
          relays: multiKindRelays,
          filters: [{ kinds: [30784], '#d': ['satrank-oracle-announcement'] }],
          onEvent: async (event) => {
            const result = await peersDiscovery.ingestAnnouncement(event);
            if (result.outcome === 'rejected') {
              logger.warn(
                { reason: result.reason, eventId: event.id.slice(0, 12), pubkey: event.pubkey.slice(0, 12) },
                'oracle-peers subscription rejected announcement',
              );
            }
          },
        });
        peersSubscriber.start().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ error: msg }, 'Failed to start oracle-peers subscriber');
        });
        logger.info('Phase 8.0 — Oracle peers subscriber started (kind 30784 permanent)');

        // Phase 8.2 — subscribe permanent kind 7402 (crowd outcome reports).
        // Ingest les outcomes publiés par n'importe quel agent Nostr,
        // pondère via Sybil resistance (PoW + identity-age + preimage-proof),
        // persist dans crowd_outcome_reports.
        const { CrowdOutcomeRepository, NostrIdentityRepository } = await import('../repositories/crowdOutcomeRepository');
        const { CrowdOutcomeIngestor, KIND_CROWD_OUTCOME } = await import('../services/crowdOutcomeIngestor');
        const crowdRepo = new CrowdOutcomeRepository(pool);
        const identityRepo = new NostrIdentityRepository(pool);
        const stagePosteriorsForCrowd = new StageRepoCtor(pool);
        const crowdIngestor = new CrowdOutcomeIngestor({
          crowdRepo,
          identityRepo,
          stagePosteriorsRepo: stagePosteriorsForCrowd,
          verifyEvent: (event) => verifyEventFn(event as unknown as Parameters<typeof verifyEventFn>[0]),
        });
        const crowdSubscriber = new NostrEventSubscriber({
          label: 'crowd-outcomes',
          relays: multiKindRelays,
          filters: [{ kinds: [KIND_CROWD_OUTCOME] }],
          onEvent: async (event) => {
            const result = await crowdIngestor.ingest(event);
            if (result.outcome === 'rejected') {
              logger.debug(
                { reason: result.reason, eventId: event.id.slice(0, 12), pubkey: event.pubkey.slice(0, 12) },
                'crowd-outcomes subscription rejected report',
              );
            }
          },
        });
        crowdSubscriber.start().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ error: msg }, 'Failed to start crowd-outcomes subscriber');
        });
        logger.info('Phase 8.2 — Crowd outcomes subscriber started (kind 7402 permanent)');

        // Phase 9.0 — crowd consolidation cron horaire. Lit les reports
        // observed >= 1h ago, weight >= 0.3 (= base), pousse vers
        // endpoint_stage_posteriors avec le weight effectif.
        const { CrowdConsolidationCron } = await import('../services/crowdConsolidationCron');
        const consolidationCron = new CrowdConsolidationCron({
          pool,
        });
        const runConsolidation = (): void => {
          consolidationCron
            .runOnce()
            .then((res) => {
              if (res.consolidated > 0 || res.errors > 0) {
                logger.info(
                  { consolidated: res.consolidated, errors: res.errors },
                  'Crowd consolidation cron tick',
                );
              }
            })
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              logger.error({ error: msg }, 'Crowd consolidation cron error');
            });
        };
        const consolidationInitialDelay = 30 * 60 * 1000;
        const consolidationIntervalMs = 60 * 60 * 1000; // hourly
        const consolidationTimer = setTimeout(() => {
          runConsolidation();
          const recurrent = setInterval(runConsolidation, consolidationIntervalMs);
          recurrent.unref?.();
        }, consolidationInitialDelay);
        consolidationTimer.unref?.();
        logger.info('Phase 9.0 — Crowd consolidation cron scheduled (hourly)');

        // Phase 9.1 — subscribe permanent kind 30783 (peer calibrations).
        const { PeerCalibrationRepository } = await import('../repositories/peerCalibrationRepository');
        const { PeerCalibrationIngestor, KIND_ORACLE_CALIBRATION: KIND_CALIB } = await import('../services/peerCalibrationIngestor');
        const peerCalibrationRepo = new PeerCalibrationRepository(pool);
        const peerCalibrationIngestor = new PeerCalibrationIngestor({
          peerCalibrationRepo,
          selfOraclePubkey: oraclePubkey,
          verifyEvent: (event) => verifyEventFn(event as unknown as Parameters<typeof verifyEventFn>[0]),
        });
        const peerCalibrationSubscriber = new NostrEventSubscriber({
          label: 'peer-calibrations',
          relays: multiKindRelays,
          filters: [{ kinds: [KIND_CALIB], '#d': ['satrank-calibration'] }],
          onEvent: async (event) => {
            const result = await peerCalibrationIngestor.ingest(event);
            if (result.outcome === 'rejected') {
              logger.debug(
                { reason: result.reason, eventId: event.id.slice(0, 12), pubkey: event.pubkey.slice(0, 12) },
                'peer-calibrations subscription rejected event',
              );
            }
          },
        });
        peerCalibrationSubscriber.start().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ error: msg }, 'Failed to start peer-calibrations subscriber');
        });
        logger.info('Phase 9.1 — Peer calibrations subscriber started (kind 30783 permanent)');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : '';
        logger.error({ error: msg, stack }, 'Failed to start Nostr multi-kind scheduler');
      }
    } else if (!config.NOSTR_MULTI_KIND_ENABLED) {
      logger.info('Nostr multi-kind scheduler disabled (NOSTR_MULTI_KIND_ENABLED=false)');
    }

    // Run an initial stale sweep so the DB reflects fossils before the first crawl fires
    await runStaleSweep(agentRepo);

    // ====================================================================
    // Vague 2 E.1 — arm the *non-LND-graph* timers BEFORE the long-running
    // initial full crawl. The probe cron, the service health tier timers
    // and the registry crawler do not depend on the LND graph nor on the
    // initial bulk scoring; running them up front means a fresh boot does
    // not have to wait ~100 min (Nostr publish marathon inside runFullCrawl)
    // before the catalogue starts updating. The LND graph + LN+ timers
    // stay below because their callback shares the bulkScoreAll path with
    // runFullCrawl and ordering them after preserves the historical
    // "first crawl drives the first ranking" invariant.
    // ====================================================================

    let timerProbe: ReturnType<typeof setInterval> | null = null;
    if (probeCrawlerInstance) {
      let probeRunning = false;
      timerProbe = setInterval(async () => {
        if (probeRunning) return; // skip if previous cycle still running
        probeRunning = true;
        try {
          await crawlProbe(probeCrawlerInstance, probeRepo);
        } catch (err: unknown) {
          logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Probe crawl error');
        } finally {
          probeRunning = false;
        }
      }, intervals.probe);
      logger.info({ intervalMs: intervals.probe }, 'Probe cron timer started');
    } else {
      logger.warn('Probe cron timer NOT started — LND not configured');
    }

    // Service health crawler — Axe 1 tiered scheduling.
    // Three independent timers, each scoped to one tier (hot/warm/cold).
    // Cadence is tuned to match the freshness window each tier guarantees:
    //   hot  → every 1h (last_intent_query < 2h, probe age < 1h)
    //   warm → every 6h (last_intent_query < 24h, probe age < 6h)
    //   cold → every 6h  (Vague 1 C.1.a, was 24h)
    // A `running` flag per tier blocks overlapping cycles when a previous
    // sweep takes longer than the interval (cold tier scans the largest pool).
    const { ServiceHealthCrawler } = await import('./serviceHealthCrawler');
    const { ServiceEndpointRepository } = await import('../repositories/serviceEndpointRepository');
    const { EndpointStagePosteriorsRepository } = await import('../repositories/endpointStagePosteriorsRepository');
    const { InvoiceValidityService } = await import('../services/invoiceValidityService');
    const serviceEndpointRepo = new ServiceEndpointRepository(pool);
    const stagePosteriorsRepo = new EndpointStagePosteriorsRepository(pool);
    const invoiceValidityService = new InvoiceValidityService(stagePosteriorsRepo);
    const serviceHealthCrawler = new ServiceHealthCrawler(
      serviceEndpointRepo,
      txRepo,
      config.TRANSACTIONS_DUAL_WRITE_MODE,
      dualWriteLogger,
      agentRepo,
      bayesianScoringServiceMain,
      invoiceValidityService,
      stagePosteriorsRepo,
    );

    const tierIntervals = {
      hot: 60 * 60 * 1000,
      warm: 6 * 60 * 60 * 1000,
      // Vague 1 C.1.a: cold cadence shortened from 24h to 6h. With idle prod and
      // zero /api/intent traffic the entire catalogue lives in cold tier; a 24h
      // cycle made check_count climb too slowly to clear the active_count >= 3
      // threshold, leaving every category at active_count=0 visibly. 6h is still
      // 6x slower than warm and keeps the LND/HTTP load negligible (220 endpoints
      // at 5/sec = ~45s per cycle).
      cold: 6 * 60 * 60 * 1000,
    } as const;

    for (const tier of ['hot', 'warm', 'cold'] as const) {
      let running = false;
      const timer = setInterval(async () => {
        if (running) return;
        running = true;
        try {
          await serviceHealthCrawler.runTier(tier);
        } catch (err: unknown) {
          logger.error(
            { tier, error: err instanceof Error ? err.message : String(err) },
            'Service health tier crawl error',
          );
        } finally {
          running = false;
        }
      }, tierIntervals[tier]);
      timer.unref?.();
      logger.info({ tier, intervalMs: tierIntervals[tier] }, 'Service health tier timer started');
    }

    // Registry crawler — discovers L402 endpoints from 402index.io (every 24h)
    const { RegistryCrawler } = await import('./registryCrawler');
    const decodeBolt11 = lndClient.isConfigured() && lndClient.decodePayReq
      ? (invoice: string) => lndClient.decodePayReq!(invoice)
      : undefined;
    const registryCrawler = new RegistryCrawler(serviceEndpointRepo, decodeBolt11);

    // Initial fire — sans cela, un cut-over (Phase 12B) laisse
    // service_endpoints vide pendant 24h et /api/intent/categories renvoie
    // []. Fire-and-forget : on ne bloque pas la boucle cron sur cette
    // première passe (elle peut prendre ~minutes à 500ms/req).
    (async () => {
      try {
        await registryCrawler.run();
      } catch (err: unknown) {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Initial registry crawl error');
      }
    })();

    const timerRegistry = setInterval(async () => {
      try {
        await registryCrawler.run();
      } catch (err: unknown) {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Registry crawl error');
      }
    }, config.CRAWL_INTERVAL_REGISTRY_MS);
    timerRegistry.unref?.();
    logger.info({ intervalMs: config.CRAWL_INTERVAL_REGISTRY_MS }, 'Registry crawler timer started');

    // Vague 3 Phase 3 — l402.directory secondary catalogue source. Smaller
    // (8 services / 42 endpoints today) but verified via .well-known and
    // exposes consumption_type + provider_contact signals 402index lacks.
    // Reuses RegistryCrawler.probeUrl so the BOLT11→agent_hash discovery
    // primitive stays single-sourced. Same 24h cadence and unref() pattern
    // as the registry crawler.
    const { L402DirectoryCrawler } = await import('./l402DirectoryCrawler');
    const l402DirectoryCrawler = new L402DirectoryCrawler(serviceEndpointRepo, registryCrawler);

    (async () => {
      try {
        await l402DirectoryCrawler.run();
      } catch (err: unknown) {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Initial l402.directory crawl error');
      }
    })();

    const timerL402Directory = setInterval(async () => {
      try {
        await l402DirectoryCrawler.run();
      } catch (err: unknown) {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'l402.directory crawl error');
      }
    }, config.CRAWL_INTERVAL_REGISTRY_MS);
    timerL402Directory.unref?.();
    logger.info({ intervalMs: config.CRAWL_INTERVAL_REGISTRY_MS }, 'L402Directory crawler timer started');

    // Retention cleanup — sweep old rows from time-series tables
    // (probe_results, score_snapshots, channel_snapshots, fee_snapshots)
    // before the first crawl so we start with a trimmed dataset.
    try {
      await runRetentionCleanup(pool);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg }, 'Initial retention cleanup failed');
    }

    // Initial full crawl — Nostr publish happens inside, right after bulk scoring
    await runFullCrawl(
      lndGraphCrawlerInstance, mempoolCrawlerInstance,
      lnplusCrawlerInstance, probeCrawlerInstance, probeRepo, agentRepo, scoringService,
      bayesianVerdictServiceMain, snapshotRepo,
      nostrPublishFn,
    );

    // Post-crawl sweep: any agent not touched during the graph crawl whose last_seen is > 90d
    // will now be flagged. Agents that were seen had their stale reset to 0 by the crawler updates.
    await runStaleSweep(agentRepo);

    // LND graph + LN+ timers stay AFTER runFullCrawl because their callback
    // re-runs bulkScoreAll, which would race with the initial scoring above.
    const timerLnd = setInterval(async () => {
      try {
        await crawlLightning(lndGraphCrawlerInstance, mempoolCrawlerInstance);
        await bulkScoreAll(agentRepo, scoringService, bayesianVerdictServiceMain, snapshotRepo);
      } catch (err: unknown) {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'LND graph crawl error');
      }
    }, intervals.lndGraph);

    const timerLnplus = setInterval(async () => {
      try {
        await crawlLnplus(lnplusCrawlerInstance);
        await bulkScoreAll(agentRepo, scoringService, bayesianVerdictServiceMain, snapshotRepo);
      } catch (err: unknown) {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'LN+ crawl error');
      }
    }, intervals.lnplus);



    // Daily stale sweep — flags agents whose last_seen has fallen outside the 90-day window.
    const timerStaleSweep = setInterval(async () => {
      try {
        await runStaleSweep(agentRepo);
      } catch (err: unknown) {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Scheduled stale sweep failed');
      }
    }, STALE_SWEEP_INTERVAL_MS);
    logger.info({ intervalMs: STALE_SWEEP_INTERVAL_MS, thresholdSec: STALE_THRESHOLD_SEC }, 'Stale sweep cron timer started');

    // Daily retention cleanup — sweeps old rows from time-series tables.
    // Fire-and-forget inside setInterval; try/catch logs without crashing
    // the cron loop if one sweep fails (next tick will retry).
    const timerRetention = setInterval(async () => {
      try {
        await runRetentionCleanup(pool);
      } catch (err: unknown) {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Scheduled retention cleanup failed');
      }
    }, RETENTION_INTERVAL_MS);
    logger.info({ intervalMs: RETENTION_INTERVAL_MS }, 'Retention cleanup cron timer started');

    // Phase 12B : le WAL checkpoint SQLite a disparu avec la migration vers
    // Postgres (autovacuum / WAL archiving y sont gérés côté cluster).

    const shutdown = async () => {
      logger.info('Stopping cron crawler');
      clearInterval(timerHeartbeat);
      clearInterval(timerLnd);
      clearInterval(timerLnplus);
      if (timerProbe) clearInterval(timerProbe);
      if (timerNostr) clearInterval(timerNostr);
      if (timerZapMining) clearInterval(timerZapMining);
      if (timerNostrMultiKind) clearInterval(timerNostrMultiKind);
      if (multiKindPublisherRef) {
        try {
          await multiKindPublisherRef.close();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ error: msg }, 'multi-kind publisher close failed');
        }
      }
      clearInterval(timerStaleSweep);
      clearInterval(timerRetention);
      metricsServer.close();
      await closePools();
      process.exit(0);
    };
    process.on('SIGINT', () => { void shutdown(); });
    process.on('SIGTERM', () => { void shutdown(); });
  } else {
    await runStaleSweep(agentRepo);
    await runFullCrawl(
      lndGraphCrawlerInstance, mempoolCrawlerInstance,
      lnplusCrawlerInstance, probeCrawlerInstance, probeRepo, agentRepo, scoringService,
      bayesianVerdictServiceMain, snapshotRepo,
    );
    await runStaleSweep(agentRepo);
    await closePools();
  }
}

main().catch(async (err) => {
  logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Fatal crawler error');
  try { await closePools(); } catch { /* already closed */ }
  process.exit(1);
});
