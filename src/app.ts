// Express application setup — dependency injection
import express, { Router } from 'express';
import path from 'path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config, featureFlags } from './config';
import { DEFAULT_NOSTR_RELAYS } from './nostr/relays';
import { getPool } from './database/connection';
import { requestIdMiddleware } from './middleware/requestId';
import { requestTimeout } from './middleware/timeout';
import { errorHandler } from './middleware/errorHandler';
import { metricsMiddleware, metricsRegistry, agentsTotal, channelsTotal, operatorsTotal, rateLimitHits } from './middleware/metrics';
import { createProbeRateLimit } from './middleware/probeRateLimit';

// Repositories
import { AgentRepository } from './repositories/agentRepository';
import { TransactionRepository } from './repositories/transactionRepository';
import { AttestationRepository } from './repositories/attestationRepository';
import { SnapshotRepository } from './repositories/snapshotRepository';
import { ProbeRepository } from './repositories/probeRepository';

// Services
import { ScoringService } from './services/scoringService';
import { AgentService } from './services/agentService';
import { AttestationService } from './services/attestationService';
import { StatsService } from './services/statsService';
import { TrendService } from './services/trendService';
import { VerdictService } from './services/verdictService';
import { RiskService } from './services/riskService';
import { ReportService } from './services/reportService';
import { ReportBonusService } from './services/reportBonusService';
import { LndInvoiceService } from './services/lndInvoiceService';
import { ReportBonusRepository } from './repositories/reportBonusRepository';
import { NpubAgeCache } from './nostr/npubAgeCache';
import { SurvivalService } from './services/survivalService';
import { ChannelFlowService } from './services/channelFlowService';
import { FeeVolatilityService } from './services/feeVolatilityService';
import { AutoIndexService } from './services/autoIndexService';
import { ChannelSnapshotRepository } from './repositories/channelSnapshotRepository';
import { FeeSnapshotRepository } from './repositories/feeSnapshotRepository';
import { HttpLndGraphClient } from './crawler/lndGraphClient';
import { LndGraphCrawler } from './crawler/lndGraphCrawler';

// Controllers
import { AgentController } from './controllers/agentController';
import { AttestationController } from './controllers/attestationController';
import { HealthController } from './controllers/healthController';
import { V2Controller } from './controllers/v2Controller';
import { PingController } from './controllers/pingController';
import { DepositController } from './controllers/depositController';
import { ProbeController } from './controllers/probeController';
import { ServiceController } from './controllers/serviceController';
import { IntentController } from './controllers/intentController';
import { IntentService } from './services/intentService';
import AnthropicSdk from '@anthropic-ai/sdk';
import { Bm25Service } from './services/bm25Service';
import {
  Bm25HybridRanker,
  LegacyRanker,
  LlmRerankRanker,
  buildAnthropicRerankAdapter,
  type IntentRanker,
} from './services/intentRanker';
import { OperatorReplayStateService } from './services/operatorReplayStateService';
import { GoldenCanaryService } from './services/goldenCanaryService';
import { GOLDEN_PAIRS } from './services/goldenSetData';

/** Phase 12.4 — populate the in-memory BM25 inverted index from the
 *  current catalogue. Run once at boot and on a 5min cron tick.
 *  Document text = name + description + category + provider concat'd. */
async function rebuildBm25Index(
  bm25: Bm25Service,
  serviceEndpointRepo: ServiceEndpointRepository,
): Promise<void> {
  const endpoints = await serviceEndpointRepo.listActiveTrustedEndpoints(10_000);
  const docs = endpoints.map(svc => ({
    id: svc.id,
    text: [svc.name, svc.description, svc.category, svc.provider]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join(' '),
  }));
  bm25.buildIndex(docs);
  logger.info(
    { docs: docs.length, ...bm25.stats() },
    'Bm25Service: index rebuilt (Phase 12.4)',
  );
}
import { ServiceRegisterController } from './controllers/serviceRegisterController';
import { FulfillController } from './controllers/fulfillController';
import { FulfillService } from './services/fulfillService';
import { FulfillJobRepository } from './repositories/fulfillJobRepository';
import { RefundLedgerRepository } from './repositories/refundLedgerRepository';
import { RefundDisputeRepository } from './repositories/refundDisputeRepository';
import { RefundEngine } from './services/refundEngine';
import { DisputeController } from './controllers/disputeController';
import { EndpointSchemaRepository } from './repositories/endpointSchemaRepository';
import { SchemaController } from './controllers/schemaController';
import { PoolAccountingService } from './services/poolAccountingService';
import { LndHoldInvoiceService } from './services/lndHoldInvoiceService';
import { OperatorBondRepository } from './repositories/operatorBondRepository';
import { AgentClaimRepository } from './repositories/agentClaimRepository';
import { OperatorBondService } from './services/operatorBondService';
import { ClaimEngine } from './services/claimEngine';
import { ClaimController } from './controllers/claimController';
import { SignerService } from './services/signerService';
import { EvidenceReceiptRepository } from './repositories/evidenceReceiptRepository';
import { EvidenceService } from './services/evidenceService';
import { EvidenceController } from './controllers/evidenceController';
// AEPS §8 (2026-05-07) — Bitcoin L1 trust root for evidence.
import { DailyMerkleAnchorRepository } from './repositories/dailyMerkleAnchorRepository';
import { DailyMerkleAnchorService, unixSecToUtcDay, buildOpReturnPayload } from './services/dailyMerkleAnchorService';
import { AepsEvidenceController } from './controllers/aepsEvidenceController';
import { createAepsEvidenceRoutes } from './routes/aepsEvidence';
// AEPS §8.3 (2026-05-07) — Nostr publication of daily anchors.
import { buildAndSignAnchorEvent, publishAnchorToRelays } from './services/aepsAnchorPublisher';
import { AepsL1BroadcastService } from './services/aepsL1BroadcastService';
import { Kind31403Consumer } from './nostr/kind31403Consumer';
// AEPS §8.5 (2026-05-08) — Nostr publication of detected fork events.
import { buildAndSignForkEvent } from './services/aepsForkPublisher';
import { Kind31410Consumer } from './nostr/kind31410Consumer';
// AEPS §6.3 (2026-05-08) — Multi-hop HTLC chain HTTP surface.
import { MultiHopChainRepository } from './repositories/multiHopChainRepository';
import { MultiHopChainService } from './services/multiHopChainService';
import { AepsMultiHopController } from './controllers/aepsMultiHopController';
import { createAepsMultiHopRoutes } from './routes/aepsMultiHop';
// AEPS §8.5 + §10 (2026-05-07) — fork detection + DLC dispute resolution.
import { AepsObserverRepository } from './repositories/aepsObserverRepository';
import { ForkDetectionService } from './services/forkDetectionService';
import { AepsDisputeRepository } from './repositories/aepsDisputeRepository';
import { DisputeService } from './services/disputeService';
import { buildDisputeClaim } from './services/disputeClaimAdapter';
import { AepsDisputeController } from './controllers/aepsDisputeController';
import { createAepsDisputeRoutes } from './routes/aepsDispute';
import { AepsObserverController } from './controllers/aepsObserverController';
import { createAepsObserverRoutes } from './routes/aepsObserver';
// AEPS §10 equivocation slashing.
import { AepsOracleSlashRepository } from './repositories/aepsOracleSlashRepository';
import { EquivocationClaimAdapter } from './services/equivocationClaimAdapter';
import { EquivocationSlashCron } from './services/equivocationSlashCron';
import { OperatorAttestationRepository } from './repositories/operatorAttestationRepository';
import { OperatorAttestationService } from './services/operatorAttestationService';
import { OperatorEndpointRegistrationRepository } from './repositories/operatorEndpointRegistrationRepository';
import { OperatorEndpointRegistrationService } from './services/operatorEndpointRegistrationService';
import { OperatorRegistrationController } from './controllers/operatorRegistrationController';
import { AgentBondRepository } from './repositories/agentBondRepository';
import { AgentBondService } from './services/agentBondService';
import { AgentBondController } from './controllers/agentBondController';
import { AgentReputationRepository } from './repositories/agentReputationRepository';
import { AgentReputationService } from './services/agentReputationService';
import { AgentReputationController } from './controllers/agentReputationController';
import { AgentSlashingService } from './services/agentSlashingService';
import { AgentCreditRepository } from './repositories/agentCreditRepository';
import { IntentResultCacheRepository } from './repositories/intentResultCacheRepository';
import { CapabilityTokenService } from './services/capabilityTokenService';
import { ServiceRegisterLogRepository } from './repositories/serviceRegisterLogRepository';
import { OperatorController } from './controllers/operatorController';
import { OperatorService } from './services/operatorService';
import {
  OperatorRepository,
  OperatorIdentityRepository,
  OperatorOwnershipRepository,
} from './repositories/operatorRepository';
import { EndpointController } from './controllers/endpointController';
import { WatchlistController } from './controllers/watchlistController';
import { ReportStatsController } from './controllers/reportStatsController';
import { BayesianScoringService } from './services/bayesianScoringService';
import { BayesianVerdictService } from './services/bayesianVerdictService';
import {
  EndpointStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
  OperatorStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  RouteStreamingPosteriorRepository,
} from './repositories/streamingPosteriorRepository';
import {
  EndpointDailyBucketsRepository,
  ServiceDailyBucketsRepository,
  OperatorDailyBucketsRepository,
  NodeDailyBucketsRepository,
  RouteDailyBucketsRepository,
} from './repositories/dailyBucketsRepository';
import { RegistryCrawler } from './crawler/registryCrawler';
import { createBalanceAuth } from './middleware/balanceAuth';
import { createL402Native } from './middleware/l402Native';
import { OracleBudgetService } from './services/oracleBudgetService';
import { TrustAssertionRepository } from './repositories/trustAssertionRepository';
import { OraclePeerRepository } from './repositories/oracleFederationRepository';
import { PeerCalibrationRepository } from './repositories/peerCalibrationRepository';
import { CalibrationRepository } from './repositories/calibrationRepository';
import { createReportAuth, safeEqual } from './middleware/auth';
import { ServiceEndpointRepository } from './repositories/serviceEndpointRepository';
import { EndpointStagePosteriorsRepository } from './repositories/endpointStagePosteriorsRepository';
import { PreimagePoolRepository } from './repositories/preimagePoolRepository';

// Routes
import { createAgentRoutes } from './routes/agent';
import { createAttestationRoutes } from './routes/attestation';
import { createHealthRoutes } from './routes/health';
import { createV2Routes } from './routes/v2';
import { createPingRoutes } from './routes/ping';

// OpenAPI spec
import { openapiSpec } from './openapi';

// Infra
import { logger } from './logger';
import { setFresh as cacheSetFresh, getStale as cacheGetStale } from './cache/memoryCache';
import { TOP_SORT_AXES, TOP_WARMUP_LIMITS, CRITICAL_CACHE_TTL_MS } from './services/statsService';
import { isFreshRequest } from './utils/freshFlag';
import { DualWriteLogger } from './utils/dualWriteLogger';
import { safeJsonForScript } from './utils/safeJsonForScript';

export function createApp() {
  const app = express();

  // Phase 12B — pg Pool. Migrations are applied once at boot in src/index.ts
  // before createApp(); creating the app is a pure synchronous wiring step.
  const pool = getPool();

  // Dependency injection
  const agentRepo = new AgentRepository(pool);
  const txRepo = new TransactionRepository(pool);
  const attestationRepo = new AttestationRepository(pool);
  const snapshotRepo = new SnapshotRepository(pool);
  const probeRepo = new ProbeRepository(pool);
  const channelSnapshotRepo = new ChannelSnapshotRepository(pool);
  const feeSnapshotRepo = new FeeSnapshotRepository(pool);

  const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, pool, probeRepo, channelSnapshotRepo, feeSnapshotRepo);
  const trendService = new TrendService(agentRepo, snapshotRepo);
  const attestationService = new AttestationService(attestationRepo, agentRepo, txRepo, pool);
  const serviceEndpointRepo = new ServiceEndpointRepository(pool);
  const endpointStagePosteriorsRepo = new EndpointStagePosteriorsRepository(pool);
  const preimagePoolRepo = new PreimagePoolRepository(pool);
  const riskService = new RiskService();

  // LND graph client — shared between auto-indexation, pathfinding, verdict,
  // and Phase 9 /api/probe (which needs the admin macaroon for payInvoice).
  const lndClient = new HttpLndGraphClient({
    restUrl: config.LND_REST_URL,
    macaroonPath: config.LND_MACAROON_PATH,
    timeoutMs: config.LND_TIMEOUT_MS,
    adminMacaroonPath: config.LND_ADMIN_MACAROON_PATH,
  });

  // statsService needs lndClient for the /api/health LND reachability check;
  // pass only when the client is actually configured so a missing macaroon
  // leaves lndStatus = 'disabled' rather than 'unknown' forever.
  const statsService = new StatsService(
    agentRepo, txRepo, attestationRepo, snapshotRepo, pool, trendService,
    probeRepo, serviceEndpointRepo,
    lndClient.isConfigured() ? lndClient : undefined,
  );

  // Phase 3 : Bayesian scoring stack — built before VerdictService so it can
  // be injected. BayesianVerdictService is a read-side composer that owns the
  // canonical Bayesian shape consumed across all public endpoints.
  const endpointStreamingRepo = new EndpointStreamingPosteriorRepository(pool);
  const serviceStreamingRepo = new ServiceStreamingPosteriorRepository(pool);
  const operatorStreamingRepo = new OperatorStreamingPosteriorRepository(pool);
  const nodeStreamingRepo = new NodeStreamingPosteriorRepository(pool);
  const routeStreamingRepo = new RouteStreamingPosteriorRepository(pool);
  const endpointBucketsRepo = new EndpointDailyBucketsRepository(pool);
  const serviceBucketsRepo = new ServiceDailyBucketsRepository(pool);
  const operatorBucketsRepo = new OperatorDailyBucketsRepository(pool);
  const nodeBucketsRepo = new NodeDailyBucketsRepository(pool);
  const routeBucketsRepo = new RouteDailyBucketsRepository(pool);
  const bayesianScoringService = new BayesianScoringService(
    endpointStreamingRepo, serviceStreamingRepo, operatorStreamingRepo, nodeStreamingRepo, routeStreamingRepo,
    endpointBucketsRepo, serviceBucketsRepo, operatorBucketsRepo, nodeBucketsRepo, routeBucketsRepo,
  );
  const bayesianVerdictService = new BayesianVerdictService(
    bayesianScoringService, endpointStreamingRepo, endpointBucketsRepo, snapshotRepo, serviceEndpointRepo,
  );

  const agentService = new AgentService(agentRepo, txRepo, attestationRepo, bayesianVerdictService, probeRepo);

  // Phase 7 — operator abstraction construit en amont pour permettre à
  // VerdictService d'exposer operator_id (C11) et l'advisory OPERATOR_UNVERIFIED
  // (C12). OperatorController est instancié plus bas (dépend de agentRepo).
  const operatorRepo = new OperatorRepository(pool);
  const operatorIdentityRepo = new OperatorIdentityRepository(pool);
  const operatorOwnershipRepo = new OperatorOwnershipRepository(pool);
  const operatorService = new OperatorService(
    operatorRepo,
    operatorIdentityRepo,
    operatorOwnershipRepo,
    endpointStreamingRepo,
    nodeStreamingRepo,
    serviceStreamingRepo,
  );

  const verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, riskService, bayesianVerdictService, probeRepo, lndClient.isConfigured() ? lndClient : undefined, operatorService);
  const survivalService = new SurvivalService(agentRepo, probeRepo, snapshotRepo);
  const channelFlowService = new ChannelFlowService(channelSnapshotRepo);
  const feeVolatilityService = new FeeVolatilityService(feeSnapshotRepo, agentRepo);

  const lndGraphCrawler = lndClient.isConfigured()
    ? new LndGraphCrawler(lndClient, agentRepo, channelSnapshotRepo, feeSnapshotRepo)
    : null;
  const autoIndexService = new AutoIndexService(
    lndGraphCrawler, agentRepo, scoringService, config.AUTO_INDEX_MAX_PER_MINUTE,
    bayesianVerdictService,
  );

  // Phase 1 shadow-mode: construct the NDJSON logger only when dry_run is
  // active (mirrors the crawler process — silent contract in off/active, no
  // filesystem setup when not needed). Shared across reportService + future
  // in-process writers if any.
  const dualWriteLogger = config.TRANSACTIONS_DUAL_WRITE_MODE === 'dry_run'
    ? new DualWriteLogger(config.TRANSACTIONS_DRY_RUN_LOG_PATH)
    : undefined;
  const reportService = new ReportService(
    attestationRepo, agentRepo, txRepo, scoringService, pool,
    config.TRANSACTIONS_DUAL_WRITE_MODE,
    dualWriteLogger,
    bayesianScoringService,
    // Audit Tier 3C — operator_id cross-reference. When reporter and target
    // are owned by the same operator (Mallory's multiple LN nodes), the
    // report is rejected to prevent backdoor self-promotion.
    operatorOwnershipRepo,
  );

  // Tier 2 report bonus — gated by REPORT_BONUS_ENABLED env (off by default).
  // Constructing the service has no side effects when disabled; the guard
  // watcher is only started when the flag is true at boot.
  const reportBonusRepo = new ReportBonusRepository(pool);
  // Phase 12B — DB_PATH was removed with SQLite; npub-age cache is a plain
  // file under ./data, same directory convention as the old sqlite file.
  const npubAgeCachePath = path.join(process.cwd(), 'data', 'nostr-pubkey-ages.json');
  const npubAgeCache = new NpubAgeCache(npubAgeCachePath);
  npubAgeCache.reload();
  // Hourly reload so Stream B file updates propagate without process restart (audit M5).
  npubAgeCache.startAutoReload();
  const reportBonusService = new ReportBonusService(pool, reportBonusRepo, scoringService, npubAgeCache, {
    enabledFromEnv: config.REPORT_BONUS_ENABLED,
    threshold: config.REPORT_BONUS_THRESHOLD,
    dailyCap: config.REPORT_BONUS_DAILY_CAP,
    satsPerBonus: config.REPORT_BONUS_SATS,
    minReporterScore: config.REPORT_BONUS_MIN_REPORTER_SCORE,
    minNpubAgeDays: config.REPORT_BONUS_MIN_NPUB_AGE_DAYS,
    rollbackRatio: config.REPORT_BONUS_ROLLBACK_RATIO,
    guardIntervalMs: config.REPORT_BONUS_GUARD_INTERVAL_MS,
  });
  reportBonusService.startGuard();

  const agentController = new AgentController(agentService, agentRepo, verdictService, autoIndexService, pool);
  const attestationController = new AttestationController(attestationService);
  const healthController = new HealthController(statsService);
  const v2Controller = new V2Controller(reportService, agentService, agentRepo, attestationRepo, scoringService, trendService, riskService, probeRepo, survivalService, channelFlowService, feeVolatilityService, pool, reportBonusService, preimagePoolRepo);
  const pingController = new PingController(lndClient.isConfigured() ? lndClient : undefined, agentRepo, probeRepo);
  const lndInvoiceService = new LndInvoiceService({
    restUrl: config.LND_REST_URL,
    macaroonPath: config.LND_INVOICE_MACAROON_PATH,
  });
  // Self-funding loop tracker — constructed here (instead of at line ~531)
  // so DepositController can log deposits as revenue at settlement. Audit
  // 2026-04-29 found the budget loop reporting revenue=0 because deposits
  // were not wired to logRevenue.
  const oracleBudgetService = new OracleBudgetService(pool);
  const depositController = new DepositController(pool, lndInvoiceService, oracleBudgetService);
  const probeController = new ProbeController(pool, lndClient, {
    txRepo,
    bayesian: bayesianScoringService,
    serviceEndpointRepo,
    agentRepo,
    dualWriteMode: config.TRANSACTIONS_DUAL_WRITE_MODE,
    dualWriteLogger,
  });
  const serviceController = new ServiceController(serviceEndpointRepo, agentRepo, agentService, bayesianVerdictService);
  // Phase 12.4 (2026-05-05) — IntentRanker selection.
  //
  //   RANKER_MODE=legacy   (default) — pre-P12 ordering (back-compat).
  //   RANKER_MODE=bm25     — BM25 hybrid (0.5 BM25 + 0.5 p_e2e).
  //   RANKER_MODE=bm25_llm — BM25 narrow → Claude Haiku rerank top-K.
  //
  // The BM25 service holds an in-memory inverted index ; rebuilt every
  // 5 min so newly registered endpoints surface in re-ranked /api/intent
  // responses. First build runs once at startup ; the /api/intent path
  // is safe to serve before the first build (Bm25Service falls through
  // to legacy when buildIndex hasn't been called).
  // Phase 12.9 (2026-05-06) — shared operator replay-state service.
  // fulfillService writes on every pay_invoice_replayed ; the IntentRanker
  // reads at rank time to downrank locked-out operators. Single instance
  // wired into both deps so they share the same lockout view.
  const operatorReplayState = new OperatorReplayStateService();

  const rankerMode = (process.env.RANKER_MODE ?? 'legacy').toLowerCase();
  const bm25Service = new Bm25Service();
  // Fire-and-forget initial build ; subsequent rebuilds via 5-min cron.
  // Bm25Service.score / topK return 0 / [] before the first build, so
  // the ranker degrades gracefully to legacy ordering during the
  // ~50-200ms it takes to load and tokenise the catalogue.
  void rebuildBm25Index(bm25Service, serviceEndpointRepo).catch(err => {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Bm25Service: initial build failed (legacy ordering will apply until next rebuild)',
    );
  });
  const bm25RebuildTimer = setInterval(() => {
    rebuildBm25Index(bm25Service, serviceEndpointRepo).catch(err => {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Bm25Service: scheduled rebuild failed (will retry next tick)',
      );
    });
  }, 5 * 60 * 1000);
  bm25RebuildTimer.unref();
  let intentRanker: IntentRanker | undefined;
  if (rankerMode === 'bm25') {
    intentRanker = new Bm25HybridRanker({ bm25: bm25Service, replayState: operatorReplayState });
    logger.info({ ranker: 'bm25_hybrid' }, 'IntentRanker selected (Phase 12.4)');
  } else if (rankerMode === 'bm25_llm') {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      logger.warn({}, 'RANKER_MODE=bm25_llm requested but ANTHROPIC_API_KEY missing — falling back to bm25');
      intentRanker = new Bm25HybridRanker({ bm25: bm25Service, replayState: operatorReplayState });
    } else {
      const anthropicClient = new AnthropicSdk({ apiKey: anthropicKey });
      const llmCall = buildAnthropicRerankAdapter({
        client: anthropicClient as unknown as Parameters<typeof buildAnthropicRerankAdapter>[0]['client'],
        model: process.env.RANKER_LLM_MODEL ?? 'claude-haiku-4-5-20251001',
      });
      intentRanker = new LlmRerankRanker({
        bm25: bm25Service,
        llmCall,
        narrowTopK: Number(process.env.RANKER_NARROW_TOPK ?? 20),
        finalTopK: Number(process.env.RANKER_FINAL_TOPK ?? 10),
        fallback: new Bm25HybridRanker({ bm25: bm25Service, replayState: operatorReplayState }),
      });
      logger.info({ ranker: 'llm_rerank', model: process.env.RANKER_LLM_MODEL ?? 'claude-haiku-4-5-20251001' }, 'IntentRanker selected (Phase 12.4)');
    }
  } else {
    // Phase 12.9 — even in legacy mode, the replay-state downrank applies
    // because the existing intentService swap path (see resolveIntent
    // .maybeApplyIntentRanker) is bypassed for empty req.text. We attach
    // a LegacyRanker so the lockout penalty still kicks in when the
    // ranker IS exercised (req.text supplied or auto-synthesized).
    intentRanker = new LegacyRanker({ replayState: operatorReplayState });
    logger.info({ ranker: 'legacy' }, 'IntentRanker selected (Phase 12.4 default)');
  }
  const intentService = new IntentService({
    serviceEndpointRepo,
    agentRepo,
    agentService,
    bayesianVerdictService,
    trendService,
    probeRepo,
    operatorService,
    endpointStagePosteriorsRepo,
    intentRanker,
  });
  const intentController = new IntentController(intentService);

  // Phase 12.5 (2026-05-05) — golden-set canary. Audit non-negotiable
  // for shipping a ranking layer ; alerts when recall@K drops below
  // GOLDEN_CANARY_THRESHOLD (default 0.7). Cron runs every
  // GOLDEN_CANARY_INTERVAL_MS (default 5min). Pairs are compiled into
  // the bundle via goldenSetData.ts so the canary is always available
  // regardless of Dockerfile COPY scope.
  const goldenCanaryService = GOLDEN_PAIRS.length > 0
    ? new GoldenCanaryService({
        intentService,
        pairs: GOLDEN_PAIRS,
        alertThreshold: Number(process.env.GOLDEN_CANARY_THRESHOLD ?? 0.7),
      })
    : undefined;
  if (goldenCanaryService) {
    const intervalMs = Number(process.env.GOLDEN_CANARY_INTERVAL_MS ?? 5 * 60 * 1000);
    // Run once at boot (after BM25 first build settles, ~1s).
    setTimeout(() => {
      goldenCanaryService.run().catch(err => {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          'GoldenCanary: initial run threw',
        );
      });
    }, 5_000);
    const canaryTimer = setInterval(() => {
      goldenCanaryService.run().catch(err => {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          'GoldenCanary: scheduled run threw',
        );
      });
    }, intervalMs);
    canaryTimer.unref();
    logger.info({ pairs: GOLDEN_PAIRS.length, intervalMs }, 'GoldenCanary: enabled (Phase 12.5)');
  }
  const endpointController = new EndpointController(bayesianVerdictService, serviceEndpointRepo, agentRepo, operatorService);
  const watchlistController = new WatchlistController(agentRepo, snapshotRepo, agentService);
  const reportStatsController = new ReportStatsController(pool, reportBonusRepo, () => reportBonusService.isEnabled());

  // Self-registration — uses LND BOLT11 decoder if available
  const decodeBolt11 = lndClient.isConfigured() && lndClient.decodePayReq
    ? (invoice: string) => lndClient.decodePayReq!(invoice)
    : undefined;
  const registryCrawler = decodeBolt11 ? new RegistryCrawler(serviceEndpointRepo, decodeBolt11, preimagePoolRepo) : null;
  const serviceRegisterLogRepo = new ServiceRegisterLogRepository(pool);
  const serviceRegisterController = new ServiceRegisterController({
    registryCrawler,
    serviceEndpointRepo,
    registerLogRepo: serviceRegisterLogRepo,
    operatorService,
  });

  // Phase 1 (2026-05-01) — Fulfill proxy. SatRank's strategic pivot from
  // oracle (lecture) to execution layer (écriture). See
  // project_fulfill_proxy_plan.md. Feature-flagged via FULFILL_ENABLED env
  // var; off → /api/fulfill returns 503. The service is constructed in all
  // environments so tests can exercise it without app-wide flagging.
  const fulfillJobRepo = new FulfillJobRepository(pool);
  // Phase 2 — refund ledger + per-agent daily cap + dispute table.
  const refundLedgerRepo = new RefundLedgerRepository(pool);
  const refundDisputeRepo = new RefundDisputeRepository(pool);
  const refundEngine = new RefundEngine({ refundLedgerRepo });
  // Phase 3 — JSON Schema registry. fulfillService consumes when the
  // request carries expected_schema_hash.
  const endpointSchemaRepo = new EndpointSchemaRepository(pool);
  // Phase 4 — pool accounting + circuit breaker. Reads premium_revenue
  // from fulfill_jobs.success and sats_absorbed from refund_ledger.
  const poolAccounting = new PoolAccountingService({ pool });
  // Phase 6 — LND hold-invoice service for non-custodial mode='hold'.
  // Uses the admin macaroon (invoicesrpc.write); when not configured,
  // hold-mode requests get 503 hold_mode_unavailable cleanly.
  const holdInvoiceService = new LndHoldInvoiceService({
    restUrl: config.LND_REST_URL,
    adminMacaroonPath: config.LND_ADMIN_MACAROON_PATH,
  });
  // Phase 7 (2026-05-01) — Operator bond + agent claims. ClaimEngine opens
  // pending claims on Tier-2 delivery outcomes ; cron pays out after 24h
  // dispute window. See project_indispensability_audit_20260501.md.
  const operatorBondRepo = new OperatorBondRepository(pool);
  const agentClaimRepo = new AgentClaimRepository(pool);
  const operatorBondService = new OperatorBondService({
    bondRepo: operatorBondRepo,
    holdInvoiceService,
  });
  const claimEngine = new ClaimEngine({
    pool,
    claimRepo: agentClaimRepo,
    bondRepo: operatorBondRepo,
  });
  // Phase 9.4 — agent credit line.
  const agentCreditRepo = new AgentCreditRepository(pool);
  // Phase 9.3 — intent-keyed result cache.
  const intentCacheRepo = new IntentResultCacheRepository(pool);
  // Phase 9.2 — capability token in-memory store for Bearer bypass.
  const capabilityTokens = new CapabilityTokenService();
  // Phase 8.1 (2026-05-01) — Ed25519 signer. Loads from SATRANK_SIGNING_SK/PK
  // env. Disabled (returns 503 from /api/.well-known/satrank-key + evidence
  // endpoints) when not configured — fully back-compat with pre-Phase-8 prod.
  const signerService = new SignerService();
  // Phase 8.3 — evidence receipt service + controller.
  const evidenceReceiptRepo = new EvidenceReceiptRepository(pool);
  const evidenceService = new EvidenceService({
    fulfillJobRepo,
    receiptRepo: evidenceReceiptRepo,
    signer: signerService,
  });
  const evidenceController = new EvidenceController({
    evidenceService,
    fulfillJobRepo,
    enabled: config.FULFILL_ENABLED,
  });

  // AEPS §8 (2026-05-07) — daily Merkle anchor of evidence_receipts to
  // Bitcoin L1. The L1 broadcast itself is gated by env L1_ANCHOR_ENABLED
  // (default off until UTXO/key management is opted in). Even with broadcast
  // off, the daily root is computed and persisted so any party that ingests
  // the root via /api/aeps/anchor/:day_utc can verify inclusion.
  const dailyMerkleAnchorRepo = new DailyMerkleAnchorRepository(pool);
  // Audit fix HIGH-4 (2026-05-07) — fail-safe operator pubkey validation.
  // When SATRANK_SIGNING_PK is not configured, operatorPubkeyHex was the
  // string 'unknown' which propagated through buildOpReturnPayload and was
  // rejected at op8.length !== 8. The error was caught + logged generically.
  // Now we validate explicitly at boot : if no signing key is configured,
  // the L1 broadcast path is structurally disabled (the broadcast service
  // checks the macaroon — which is a separate gate — but the canonical
  // operator pubkey itself MUST be a 64-char hex string for downstream
  // consumers to verify the OP_RETURN payload.)
  const rawOperatorPubkey = signerService.publicKeyHex();
  const operatorPubkeyHex = rawOperatorPubkey ?? 'unknown';
  if (rawOperatorPubkey === null) {
    logger.warn(
      {},
      'AEPS §8: SATRANK_SIGNING_PK not configured — operator_pubkey defaulting to "unknown"; daily anchor will compute but every L1 broadcast attempt will fail at payload construction. To enable L1 anchoring, generate Ed25519 keypair (cf. Phase 8) and set both SK + PK env vars.',
    );
  } else if (!/^[0-9a-f]{64}$/.test(rawOperatorPubkey)) {
    // Defense-in-depth : signerService should already enforce 64-hex but if
    // a future refactor weakens that contract we'd silently produce broken
    // OP_RETURN payloads. Crash-fast at boot instead.
    logger.fatal(
      { rawOperatorPubkey: rawOperatorPubkey.slice(0, 16) + '…' },
      'AEPS §8: SATRANK_SIGNING_PK is set but does NOT match /^[0-9a-f]{64}$/. Refusing to boot — fix the env var.',
    );
    process.exit(1);
  }
  const dailyMerkleAnchorService = new DailyMerkleAnchorService({
    repo: dailyMerkleAnchorRepo,
    operatorPubkeyHex,
  });

  // Phase 12A — AEPS L1 anchor broadcast. Loads the onchain macaroon at boot ;
  // if the path is unset OR loading fails, the service is constructed with an
  // empty macaroon and skips every broadcast call. The service itself is the
  // gate (`enabled` flag) ; the cron always invokes it and trusts the
  // returned status to know whether work happened.
  let aepsOnchainMacaroonHex = '';
  if (config.LND_ONCHAIN_MACAROON_PATH) {
    try {
      const macBytes = readFileSync(config.LND_ONCHAIN_MACAROON_PATH);
      aepsOnchainMacaroonHex = macBytes.toString('hex');
      logger.info(
        { path: config.LND_ONCHAIN_MACAROON_PATH, len: aepsOnchainMacaroonHex.length },
        'AEPS L1 onchain macaroon loaded',
      );
    } catch (err) {
      logger.warn(
        {
          path: config.LND_ONCHAIN_MACAROON_PATH,
          error: err instanceof Error ? err.message : String(err),
        },
        'AEPS L1 onchain macaroon failed to load — broadcast disabled',
      );
    }
  }
  const aepsL1BroadcastService = new AepsL1BroadcastService({
    repo: dailyMerkleAnchorRepo,
    lndRestUrl: config.LND_REST_URL,
    onchainMacaroonHex: aepsOnchainMacaroonHex,
    feeApiUrl: config.AEPS_L1_FEE_API_URL,
    maxFeeRateSatVByte: config.AEPS_L1_MAX_FEE_RATE_SAT_VBYTE,
    enabled: config.AEPS_L1_BROADCAST_ENABLED,
  });
  const aepsEvidenceController = new AepsEvidenceController({
    anchorService: dailyMerkleAnchorService,
    anchorRepo: dailyMerkleAnchorRepo,
    operatorPubkeyHex,
  });

  // AEPS §8.5 + §10 (2026-05-07) — fork detection + dispute resolution.
  // ForkDetectionService scans observed_anchors for ≥2 distinct roots same
  // (operator, day) and emits a slashable fork_event.
  // DisputeService resolves §10 disputes via BIP-340 Schnorr threshold ;
  // when resolved_disputant + receipt-based, the buildDisputeClaim adapter
  // opens a ClaimEngine slashing claim against the operator's bond.
  const aepsObserverRepo = new AepsObserverRepository(pool);
  const forkDetectionService = new ForkDetectionService({
    repo: aepsObserverRepo,
    // AEPS §8.5 — auto-publish detected forks as kind 31410 to relays.
    // Best-effort : failures persist the fork locally but log + continue.
    onForkDetected: async (fork) => {
      if (!config.NOSTR_PRIVATE_KEY) return;
      try {
        const signed = await buildAndSignForkEvent(
          fork,
          Math.floor(Date.now() / 1000),
          config.NOSTR_PRIVATE_KEY,
        );
        const relays = config.NOSTR_RELAYS.split(',').map(r => r.trim()).filter(Boolean);
        const pub = await publishAnchorToRelays(signed, relays, (msg, meta) =>
          logger.warn(meta ?? {}, msg),
        );
        if (pub.relays_acked > 0) {
          await aepsObserverRepo.recordForkNostrPublish(
            fork.fork_event_id,
            pub.event_id,
            Math.floor(Date.now() / 1000),
          );
          logger.info(
            {
              fork_event_id: fork.fork_event_id,
              event_id_first8: pub.event_id.slice(0, 8),
              relays_acked: pub.relays_acked,
              relays_attempted: pub.relays_attempted,
            },
            'AEPS §8.5: fork event published to Nostr (kind 31410)',
          );
        } else {
          logger.warn(
            { fork_event_id: fork.fork_event_id, ...pub },
            'AEPS §8.5: zero relays acked fork publish',
          );
        }
      } catch (err) {
        logger.warn(
          {
            fork_event_id: fork.fork_event_id,
            error: err instanceof Error ? err.message : String(err),
          },
          'AEPS §8.5: fork Nostr publish threw',
        );
      }
    },
  });
  const aepsDisputeRepo = new AepsDisputeRepository(pool);
  // AEPS §10 — oracle slash intent storage + adapter + settlement cron.
  const aepsOracleSlashRepo = new AepsOracleSlashRepository(pool);
  const equivocationClaimAdapter = new EquivocationClaimAdapter({
    bondRepo: operatorBondRepo,
    slashRepo: aepsOracleSlashRepo,
  });
  const equivocationSlashCron = new EquivocationSlashCron({
    slashRepo: aepsOracleSlashRepo,
    bondRepo: operatorBondRepo,
    graceSec: Number(process.env.AEPS_EQUIVOCATION_GRACE_SEC ?? 3600),
  });
  const disputeService = new DisputeService({
    repo: aepsDisputeRepo,
    onResolved: async (dispute) => {
      const result = await buildDisputeClaim(dispute, {
        fulfillJobRepo,
        evidenceReceiptRepo,
        claimEngine,
      });
      if (result.status === 'claim_opened') {
        return { claim_id: result.claim_id };
      }
      return undefined;
    },
    onEquivocation: async (equivocation) => {
      const result = await equivocationClaimAdapter.openSlashForEquivocation(equivocation);
      if (result.status === 'reserved' || result.status === 'no_bond_found') {
        return { claim_id: result.slash_intent_id };
      }
      return undefined;
    },
  });
  const aepsDisputeController = new AepsDisputeController({
    disputeService,
    disputeRepo: aepsDisputeRepo,
  });
  const aepsObserverController = new AepsObserverController({
    forkService: forkDetectionService,
    observerRepo: aepsObserverRepo,
  });

  // AEPS §6.3 (2026-05-08) — Multi-hop HTLC chain orchestrator.
  const multiHopChainRepo = new MultiHopChainRepository(pool);
  const multiHopChainService = new MultiHopChainService({ repo: multiHopChainRepo });
  const aepsMultiHopController = new AepsMultiHopController({
    service: multiHopChainService,
    repo: multiHopChainRepo,
  });

  // AEPS §8.5 (2026-05-07) — kind 31403 consumer ingests peer operators'
  // daily anchors over Nostr. Each ingestion calls
  // forkDetectionService.recordObservation, which scans the (operator, day)
  // bucket and emits a fork_event when ≥2 distinct roots are now seen.
  // Disabled when AEPS_31403_CONSUMER_ENABLED=false (default on).
  if (process.env.AEPS_31403_CONSUMER_ENABLED !== 'false') {
    void (async () => {
      try {
        // @ts-expect-error nostr-tools is ESM, dynamic import works at runtime
        const { verifyEvent: verifyEventFn } = await import('nostr-tools/pure');
        const aepsRelays = config.NOSTR_RELAYS.split(',').map(r => r.trim()).filter(Boolean);
        const consumer = new Kind31403Consumer({
          forkService: forkDetectionService,
          verifyEvent: (event) => verifyEventFn(event as unknown as Parameters<typeof verifyEventFn>[0]),
          relays: aepsRelays.length > 0 ? aepsRelays : undefined,
        });
        await consumer.start();
        logger.info({ relays: aepsRelays.length }, 'AEPS §8.5: kind 31403 consumer started');
      } catch (err) {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          'AEPS §8.5: kind 31403 consumer failed to start (will retry next boot)',
        );
      }
    })();
  }

  // AEPS §8.5 (2026-05-08) — kind 31410 consumer ingests peer fork events.
  // Each event records BOTH roots as observations on our side, which
  // cascades into a local fork_event linking to OUR observation IDs.
  if (process.env.AEPS_31410_CONSUMER_ENABLED !== 'false') {
    void (async () => {
      try {
        // @ts-expect-error nostr-tools is ESM, dynamic import works at runtime
        const { verifyEvent: verifyEventFn } = await import('nostr-tools/pure');
        const aepsRelays = config.NOSTR_RELAYS.split(',').map(r => r.trim()).filter(Boolean);
        const consumer = new Kind31410Consumer({
          forkService: forkDetectionService,
          verifyEvent: (event) => verifyEventFn(event as unknown as Parameters<typeof verifyEventFn>[0]),
          relays: aepsRelays.length > 0 ? aepsRelays : undefined,
        });
        await consumer.start();
        logger.info({ relays: aepsRelays.length }, 'AEPS §8.5: kind 31410 consumer started');
      } catch (err) {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          'AEPS §8.5: kind 31410 consumer failed to start (will retry next boot)',
        );
      }
    })();
  }
  // Phase 8.4 — operator attestation. Crawler tick in the reconcile loop.
  const operatorAttestationRepo = new OperatorAttestationRepository(pool);
  const operatorAttestationService = new OperatorAttestationService({
    repo: operatorAttestationRepo,
  });
  // Phase 10 (2026-05-04) — Operator-side SDK self-registration.
  const operatorEndpointRegistrationRepo = new OperatorEndpointRegistrationRepository(pool);
  const operatorEndpointRegistrationService = new OperatorEndpointRegistrationService({
    repo: operatorEndpointRegistrationRepo,
    serviceEndpointRepo,
  });

  // Phase 11B.1 (2026-05-04) — agent bonds (symmetric to operator_bonds).
  const agentBondRepo = new AgentBondRepository(pool);
  const agentBondService = new AgentBondService({
    bondRepo: agentBondRepo,
    holdInvoiceService,
  });
  const agentBondController = new AgentBondController({
    service: agentBondService,
    enabled: config.FULFILL_ENABLED,
  });

  // Phase 11B.2 (2026-05-04) — agent reputation ledger.
  const agentReputationRepo = new AgentReputationRepository(pool);
  const agentReputationService = new AgentReputationService({ repo: agentReputationRepo });
  const agentReputationController = new AgentReputationController({
    service: agentReputationService,
    bondService: agentBondService,
  });

  // Phase 11B.3 (2026-05-04) — agent slashing primitive.
  // Phase 11B.4 (2026-05-04) — wired into the 60s reconcile cron below.
  const agentSlashingService = new AgentSlashingService({
    reputationService: agentReputationService,
    bondRepo: agentBondRepo,
  });
  const operatorRegistrationController = new OperatorRegistrationController({
    service: operatorEndpointRegistrationService,
    repo: operatorEndpointRegistrationRepo,
    enabled: config.FULFILL_ENABLED,
  });
  const fulfillService = new FulfillService({
    pool,
    fulfillJobRepo,
    intentService,
    lndClient,
    refundEngine,
    endpointSchemaRepo,
    poolAccounting,
    holdInvoiceService,
    claimEngine,
    agentCreditRepo,
    intentCacheRepo,
    signer: signerService,
    operatorEndpointRegistrationRepo,
    // Phase 11B.5 — tier-gated credit-line.
    reputationService: agentReputationService,
    bondService: agentBondService,
    // Phase 12.8 — quarantine endpoints with consecutive validator violations.
    serviceEndpointRepo,
    // Phase 12.9 — shared replay-state with the IntentRanker.
    operatorReplayState,
    // Phase 12A (2026-05-07) — auto-issue evidence on every successful
    // settle so AEPS L1 anchor has data to commit on Bitcoin.
    evidenceService,
  });
  const fulfillController = new FulfillController({
    fulfillService,
    enabled: config.FULFILL_ENABLED,
    capabilityTokens,
    reputationService: agentReputationService,
    bondService: agentBondService,
  });
  const claimController = new ClaimController({
    claimRepo: agentClaimRepo,
    bondRepo: operatorBondRepo,
    enabled: config.FULFILL_ENABLED,
  });
  // Phase 2 — operator dispute surface against Tier 2 refund classifications.
  const disputeController = new DisputeController({
    refundLedgerRepo,
    refundDisputeRepo,
    operatorService,
  });
  // Phase 3 — JSON Schema registry HTTP surface. POST is NIP-98-gated;
  // GET is free.
  const schemaController = new SchemaController({ endpointSchemaRepo });

  // Phase 7 — controller pour /api/operator(s) endpoints. operatorService est
  // construit plus haut (avant VerdictService pour les besoins C11/C12).
  const operatorController = new OperatorController({
    operatorService,
    operatorRepo,
    serviceEndpointRepo,
    agentRepo,
  });

  // Cache warm-up — fills the stats and leaderboard caches before the first
  // request lands, so the cold-start SQL rebuild (~1-2s on /api/stats) never
  // hits a real user. Failures are logged but non-fatal: the endpoints will
  // rebuild on demand if the warm-up SQL fails for any reason.
  // Phase 12B — fire-and-forget since createApp() stays sync; a promise
  // rejection here is already swallowed inside runWarmUp's per-call try/catch.
  void warmUpCaches(statsService, agentController, trendService);

  // Phase 1 (2026-05-01) — fulfill_jobs reconciliation. Every 60s, scan for
  // jobs stuck in `in_flight` past their max_latency_ms × 5 + 30s safety
  // margin, mark them aborted with reason='reconciliation_timeout'. This
  // catches LND outages or process crashes mid-payment so the per-agent
  // idempotency window doesn't refuse retries forever.
  const RECONCILIATION_INTERVAL_MS = 60_000;
  const reconcileTimer = setInterval(async () => {
    try {
      // 30s margin past the absolute longest possible job (30s max_latency
      // × 5 retries + 30s slack) — anything older is definitely orphaned.
      const stuck = await fulfillJobRepo.findStuckInFlight(Math.floor(Date.now() / 1000), 180);
      for (const job of stuck) {
        await fulfillJobRepo.settleAbort({
          job_id: job.job_id,
          reason: 'reconciliation_timeout',
          settled_at: Math.floor(Date.now() / 1000),
        });
        logger.warn(
          { job_id: job.job_id, age_sec: Math.floor(Date.now() / 1000) - job.created_at },
          'Fulfill: reconciled stuck in_flight job',
        );
      }
      // Phase 2 — auto-reject open disputes older than 24h. Without admin
      // tooling (Phase 3+), the auto-reject keeps the table from accumulating
      // perpetual "open" rows. An operator who needs longer can re-open with
      // a fresh signed event after this resolves.
      const STALE_DISPUTE_SEC = 24 * 3600;
      const rejected = await refundDisputeRepo.resolveStale(
        Math.floor(Date.now() / 1000),
        STALE_DISPUTE_SEC,
      );
      if (rejected > 0) {
        logger.info({ rejected }, 'Fulfill: auto-rejected stale open disputes');
      }
      // Phase 6 — cancel hold-invoices past their expires_at. We do this
      // proactively (vs waiting for LND auto-expire) so the agent's HTLC
      // unblocks as soon as we know the orchestrator won't run. Audit H2:
      // the SQL filters status='in_flight' so we never re-cancel terminal
      // jobs whose hold_invoice_state didn't get the final transition.
      const expired = await fulfillJobRepo.findExpiredHoldInvoices(
        Math.floor(Date.now() / 1000),
      );
      for (const job of expired) {
        if (!job.hold_invoice_payment_hash) continue;
        try {
          await holdInvoiceService.cancel(job.hold_invoice_payment_hash);
          await fulfillJobRepo.setHoldInvoiceState(job.job_id, 'expired');
          await fulfillJobRepo.settleAbort({
            job_id: job.job_id,
            reason: 'hold_invoice_expired',
            settled_at: Math.floor(Date.now() / 1000),
            attempts: job.attempts,
          });
        } catch (err) {
          logger.warn(
            { jobId: job.job_id, error: err instanceof Error ? err.message : String(err) },
            'Fulfill: hold invoice cancel-on-expiry failed (will retry next tick)',
          );
        }
      }
      // Phase 6.1 — retry pending residue refunds. Each tick attempts one
      // outbound pay per pending job; after RESIDUE_REFUND_MAX_ATTEMPTS the
      // refund is marked failed_absorbed so the queue doesn't block.
      const pendingRefunds = await fulfillJobRepo.findPendingRefunds();
      for (const job of pendingRefunds) {
        try {
          await fulfillService.retryPendingRefund({
            job_id: job.job_id,
            refund_bolt11: job.refund_bolt11,
            refund_amount_sats: job.refund_amount_sats,
            refund_attempts: job.refund_attempts,
          });
        } catch (err) {
          logger.warn(
            { jobId: job.job_id, error: err instanceof Error ? err.message : String(err) },
            'Fulfill: residue refund retry threw (will retry next tick)',
          );
        }
      }
      // Phase 7.5 — claim payout cron. Pending claims past 24h dispute window
      // → commit bond slash + credit agent token_balance + transition `paid`.
      // V2 (2026-05-08) : skipped when config.CLAIM_ENGINE_ENABLED=false.
      if (config.CLAIM_ENGINE_ENABLED) {
        try {
          const out = await claimEngine.payoutReadyClaims();
          if (out.paid > 0 || out.failed > 0) {
            logger.info(out, 'ClaimEngine: payout cycle complete');
          }
        } catch (err) {
          logger.error(
            { error: err instanceof Error ? err.message : String(err) },
            'ClaimEngine: payout cron threw — will retry',
          );
        }
      }
      // AEPS §10 — equivocation slash settlement cron. Reserved intents
      // past the grace period (default 1h, AEPS_EQUIVOCATION_GRACE_SEC env)
      // get committed : bond_pending → bond_slashed + §7.2 payout shares
      // recorded. Disbursement to disputant/observer wallets is a v0.2
      // follow-up ; v0.1 records the shares.
      // V2 (2026-05-08) : skipped when config.AEPS_DISPUTE_ENABLED=false.
      if (config.AEPS_DISPUTE_ENABLED) {
        try {
          const out = await equivocationSlashCron.runCycle();
          if (out.executed > 0 || out.errors > 0) {
            logger.info(out, 'AEPS §10: equivocation slash cron cycle complete');
          }
        } catch (err) {
          logger.error(
            { error: err instanceof Error ? err.message : String(err) },
            'AEPS §10: equivocation slash cron threw — will retry',
          );
        }
      }
      // Phase 9.2 — capability token in-memory cache prune.
      try {
        const dropped = capabilityTokens.pruneExpired();
        if (dropped > 0) {
          logger.info({ dropped, remaining: capabilityTokens.size() }, 'CapabilityTokenService: pruned expired tokens');
        }
      } catch (err) {
        logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          'CapabilityTokenService: prune threw',
        );
      }
      // Phase 9.3 — intent_result_cache prune of expired rows.
      try {
        const pruned = await intentCacheRepo.pruneExpired(Math.floor(Date.now() / 1000));
        if (pruned > 0) {
          logger.info({ pruned }, 'IntentResultCache: pruned expired rows');
        }
      } catch (err) {
        logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          'IntentResultCache: prune cron threw',
        );
      }
      // Phase 8.4 — operator domain attestation crawler. Verifies pending
      // declarations + re-verifies expiring ones via DNS TXT records.
      try {
        const att = await operatorAttestationService.runVerificationCycle();
        if (att.verified + att.failed > 0) {
          logger.info(att, 'OperatorAttestationService: verification cycle complete');
        }
      } catch (err) {
        logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          'OperatorAttestationService: verification cycle threw',
        );
      }
      // Phase 10 (2026-05-04) — verify pending operator-self-registrations
      // via DNS TXT _satrank-operator.<domain>. Pending rows flip to
      // 'verified' on match (endpoint becomes visible in /api/intent
      // ranking via the join in fulfillService recall) or 'failed'
      // otherwise (operator can re-submit after fixing DNS).
      try {
        const reg = await operatorEndpointRegistrationService.runVerificationCycle();
        if (reg.verified + reg.failed > 0) {
          logger.info(reg, 'OperatorEndpointRegistrationService: verification cycle complete');
        }
      } catch (err) {
        logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          'OperatorEndpointRegistrationService: verification cycle threw',
        );
      }
      // Phase 7.5 — surface underfunded operators (logging only for v1 ; the
      // catalogue ranking integration is a Phase 7.5.1 follow-up).
      try {
        const underfunded = await operatorBondService.findUnderfundedOperators();
        if (underfunded.length > 0) {
          logger.warn({ underfunded_count: underfunded.length }, 'OperatorBondService: operators below floor — should be deprioritized in catalogue');
        }
      } catch (err) {
        logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          'OperatorBondService: findUnderfundedOperators threw',
        );
      }
      // Phase 11B.6 (2026-05-05) — agent bond settlement watcher. Polls
      // LND for pending deposit invoices ; on ACCEPTED reveals the
      // preimage to claim the HTLC + unlocks the bond_pending_sats lock
      // (createDeposit creates the bond LOCKED so phantom bonds without
      // payment grant zero tier benefit). On CANCELED/EXPIRED leaves the
      // bond locked and marks the deposit settled-as-failed.
      // V2 (2026-05-08) : agent bond settlement + slashing crons skipped
      // when config.AGENT_BONDS_ENABLED=false.
      if (config.AGENT_BONDS_ENABLED) {
        try {
          await agentBondService.runSettlementCycle();
        } catch (err) {
          logger.error(
            { error: err instanceof Error ? err.message : String(err) },
            'AgentBondService: settlement cycle threw',
          );
        }
        // Phase 11B.4 (2026-05-04) — agent slashing pass. Pulls a narrow set
        // of red-flag candidates from the reputation table (score < 0.1 AND
        // ≥10 observations AND profile updated in the past 7 days) and feeds
        // them to AgentSlashingService.runSlashingPass. The service handles
        // its own per-agent 24h cool-down + bond presence check ; this cron
        // tick is just the discovery loop.
        try {
          const SLASH_LOOKBACK_SEC = 7 * 86400;
          const candidates = await agentReputationRepo.findCandidatesForSlashing(
            0.1, // SLASH_TRIGGER_SCORE
            10,  // SLASH_MIN_OBSERVATIONS
            Math.floor(Date.now() / 1000) - SLASH_LOOKBACK_SEC,
            50,  // narrow limit so a single cron tick stays cheap
          );
          if (candidates.length > 0) {
            const outcomes = await agentSlashingService.runSlashingPass(candidates);
            const slashed = outcomes.filter(o => o.status === 'slashed').length;
            if (slashed > 0) {
              logger.warn({ slashed, evaluated: candidates.length }, 'AgentSlashingService: cron pass slashed agents');
            }
          }
        } catch (err) {
          logger.error(
            { error: err instanceof Error ? err.message : String(err) },
            'AgentSlashingService: cron tick threw',
          );
        }
      }
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Fulfill reconciliation cron failed',
      );
    }
  }, RECONCILIATION_INTERVAL_MS);
  reconcileTimer.unref();

  // AEPS §8 (2026-05-07) — daily Merkle anchor cron. Runs every hour: at the
  // top of the hour, if the previous-UTC-day's anchor isn't yet computed and
  // the day is fully closed (we're past 00:00 UTC of the next day), compute
  // and persist it. This is a "compute-once-per-day" pattern in a 1h timer
  // for restart resilience: the server can crash and the cron will catch up
  // on the missed day at the next tick.
  const aepsAnchorIntervalMs = Number(process.env.AEPS_ANCHOR_INTERVAL_MS ?? 60 * 60 * 1000);
  const aepsAnchorTimer = setInterval(async () => {
    try {
      // Anchor the prior UTC day. We only compute fully-closed days.
      const yesterday = unixSecToUtcDay(Math.floor(Date.now() / 1000) - 86400);
      const result = await dailyMerkleAnchorService.computeAndPersist(yesterday);
      if (result.status === 'ok') {
        logger.info(
          {
            day_utc: result.anchor.day_utc,
            receipt_count: result.anchor.receipt_count,
            root_first8: result.anchor.root_hex.slice(0, 8),
          },
          'AEPS §8: daily anchor cron computed',
        );
        // AEPS §8.3 — publish kind 31403 to Nostr if signing key configured
        // and this anchor hasn't been published yet. Best-effort : failures
        // are logged but don't block the cron.
        if (config.NOSTR_PRIVATE_KEY && result.anchor.nostr_event_id === null) {
          try {
            const signed = await buildAndSignAnchorEvent(
              result.anchor,
              Math.floor(Date.now() / 1000),
              config.NOSTR_PRIVATE_KEY,
            );
            const relays = config.NOSTR_RELAYS.split(',').map(r => r.trim()).filter(Boolean);
            const pub = await publishAnchorToRelays(signed, relays, (msg, meta) =>
              logger.warn(meta ?? {}, msg),
            );
            if (pub.relays_acked > 0) {
              await dailyMerkleAnchorRepo.recordNostrPublish(
                result.anchor.anchor_id,
                pub.event_id,
                Math.floor(Date.now() / 1000),
              );
              logger.info(
                {
                  day_utc: result.anchor.day_utc,
                  event_id_first8: pub.event_id.slice(0, 8),
                  relays_acked: pub.relays_acked,
                  relays_attempted: pub.relays_attempted,
                },
                'AEPS §8.3: anchor published to Nostr (kind 31403)',
              );
            } else {
              logger.warn(
                { day_utc: result.anchor.day_utc, ...pub },
                'AEPS §8.3: zero relays acked anchor publish',
              );
            }
          } catch (err) {
            logger.warn(
              {
                day_utc: result.anchor.day_utc,
                error: err instanceof Error ? err.message : String(err),
              },
              'AEPS §8.3: anchor Nostr publish threw',
            );
          }
        }

        // Phase 12A — AEPS §8 L1 anchor broadcast on Bitcoin. Service is its
        // own gate ; if AEPS_L1_BROADCAST_ENABLED=false or the macaroon is
        // missing, broadcastIfReady short-circuits with status='skipped_*'.
        // We log the outcome for observability either way. Idempotent : a
        // row with l1_txid already populated returns 'skipped_already'.
        try {
          const opReturnPayload = buildOpReturnPayload(
            operatorPubkeyHex,
            result.anchor.day_utc,
            result.anchor.root_hex,
          );
          const broadcastResult = await aepsL1BroadcastService.broadcastIfReady(
            result.anchor,
            opReturnPayload,
          );
          if (broadcastResult.status === 'ok') {
            logger.info(
              {
                day_utc: result.anchor.day_utc,
                txid_first8: broadcastResult.txid.slice(0, 8),
                sat_per_vbyte: broadcastResult.sat_per_vbyte,
              },
              'AEPS §8: L1 anchor cron broadcast complete',
            );
          } else if (
            broadcastResult.status === 'skipped_cap' ||
            broadcastResult.status === 'error'
          ) {
            // These two warrant a warning ; other 'skipped_*' are silent
            // by design (disabled / no_macaroon / already / no_receipts).
            logger.warn(
              { day_utc: result.anchor.day_utc, ...broadcastResult },
              'AEPS §8: L1 anchor cron broadcast deferred',
            );
          }
        } catch (err) {
          logger.error(
            {
              day_utc: result.anchor.day_utc,
              error: err instanceof Error ? err.message : String(err),
            },
            'AEPS §8: L1 anchor cron broadcast threw',
          );
        }
      }
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'AEPS §8: daily anchor cron threw',
      );
    }
  }, aepsAnchorIntervalMs);
  aepsAnchorTimer.unref();
  // Run once at boot (after a short delay so DB pool is warm) to backfill any
  // missed prior days during downtime.
  setTimeout(() => {
    const yesterday = unixSecToUtcDay(Math.floor(Date.now() / 1000) - 86400);
    dailyMerkleAnchorService
      .computeAndPersist(yesterday)
      .catch(err =>
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          'AEPS §8: daily anchor boot-run threw',
        ),
      );
  }, 30_000);

  // Trust first proxy hop (nginx/caddy) so rate limiter sees real client IPs.
  // IMPORTANT: if a CDN (Cloudflare, Fastly) is added in front of nginx, increase to 2.
  // Wrong value = rate limiter keys on proxy IP instead of client IP.
  app.set('trust proxy', 1);

  // Global middleware
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        // Lock <base> and <form action> to same-origin to block base-tag hijacking
        // and form-relay exfiltration if a DOM-XSS sneaks past scriptSrc 'self'.
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));
  // Permissions-Policy: deny powerful browser features the site does not use.
  // Helmet 8 has no built-in middleware for this header yet, so we set it
  // directly. All entries use `()` which means "disabled for all origins".
  app.use((_req, res, next) => {
    res.setHeader(
      'Permissions-Policy',
      'accelerometer=(), ambient-light-sensor=(), autoplay=(), battery=(), ' +
      'camera=(), cross-origin-isolated=(), display-capture=(), ' +
      'document-domain=(), encrypted-media=(), fullscreen=(), geolocation=(), ' +
      'gyroscope=(), interest-cohort=(), keyboard-map=(), magnetometer=(), ' +
      'microphone=(), midi=(), payment=(), picture-in-picture=(), ' +
      'publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(), ' +
      'usb=(), web-share=(), xr-spatial-tracking=()'
    );
    next();
  });
  app.use(cors({ origin: config.CORS_ORIGIN }));
  // express.json() parses the body into req.body but does NOT expose the raw
  // bytes. NIP-98 signatures bind to sha256(rawBody) so we capture via the
  // `verify` hook. Without this, the NIP-98 payload tag check was silently
  // bypassed on every request (audit C1) and an attacker could reuse one
  // signed envelope with arbitrary bodies.
  app.use(express.json({
    limit: '10kb',
    verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
      // `buf` is the raw bytes; we copy to isolate from any downstream
      // middleware that may mutate the buffer. Only present when a body
      // was actually sent; GET/HEAD/empty-POST leave it undefined.
      if (buf && buf.length > 0) {
        req.rawBody = Buffer.from(buf);
      }
    },
  }));

  // X-API-Version header on all responses
  app.use((_req, res, next) => {
    res.setHeader('X-API-Version', '1.0');
    next();
  });

  // Prometheus request metrics
  app.use(metricsMiddleware);

  // Reject POST/PUT/PATCH requests without application/json Content-Type
  app.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
      res.status(415).json({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json' } });
      return;
    }
    next();
  });

  app.use(requestIdMiddleware);
  app.use(requestTimeout(30_000));

  // NIP-05 — Nostr identity verification (must be before static middleware)
  app.get('/.well-known/nostr.json', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.json({
      names: {
        satrank: '5d11d46de1ba4d3295a33658df12eebb5384d6d6679f05b65fec3c86707de7d4',
      },
      relays: {
        '5d11d46de1ba4d3295a33658df12eebb5384d6d6679f05b65fec3c86707de7d4': [...DEFAULT_NOSTR_RELAYS],
      },
    });
  });

  // Phase 8.1 (2026-05-01) — SatRank's Ed25519 signing public key for
  // evidence-receipt verifiers. Public, no auth, no rate limit (response
  // is static + small). Verifiers fetch this once and cache.
  app.get('/.well-known/satrank-key', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const pk = signerService.publicKeyHex();
    if (!pk) {
      res.status(503).json({ error: 'signing_disabled', message: 'SatRank signer is not configured' });
      return;
    }
    res.json({
      satrank_pubkey: pk,
      algorithm: 'ed25519',
      use: 'evidence_receipt',
      verifier_doc: 'https://satrank.dev/docs/evidence-verification',
    });
  });

  // SSR boot: inject cached stats into index.html so the hero/stats block
  // renders at first paint, zero API fetch needed. The template is read once
  // at startup (immutable inside the Docker image).
  const publicDir = path.join(__dirname, '..', 'public');
  const indexTemplate = readFileSync(path.join(publicDir, 'index.html'), 'utf8');

  app.get('/', (_req, res) => {
    const stats = cacheGetStale<Record<string, unknown>>('stats:network');
    const boot = { stats: stats ?? null };
    const safeJson = safeJsonForScript(boot);
    const script = `<script>window.__SATRANK_BOOT__=${safeJson}</script>`;
    res.type('html').send(indexTemplate.replace('</head>', script + '\n</head>'));
  });

  // Static assets (CSS, JS, images, etc.)
  app.use(express.static(publicDir));
  app.get('/methodology', (_req, res) => res.sendFile('methodology.html', { root: publicDir }));
  // /docs : quickstart + API reference humain. Distinct de /api/docs (Swagger UI)
  // qui sert l'exploration interactive de l'OpenAPI 3.1.
  app.get('/docs', (_req, res) => res.sendFile('docs.html', { root: publicDir }));

  // Prometheus metrics endpoint — X-API-Key auth always required.
  // Phase 12B B6.2 : the historical localhost bypass was removed — IP-based
  // auth is weak when `trust proxy` is miscounted (CDN hop added, CNI/overlay
  // quirks), and a constant-time API-key compare is cheap enough to apply on
  // every scrape. L402_BYPASS keeps the endpoint open on the staging/bench
  // plane (fail-safed against prod by the boot guard in config.ts).
  // Dedicated rate limiter — `/metrics` is mounted before the /api rate
  // limiter. Without a limiter here, the API_KEY comparison is brute-forceable
  // at wire speed (audit H6).
  const metricsRateLimit = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip ?? '0.0.0.0',
    message: 'Too many metrics requests',
    skip: () => config.L402_BYPASS,
    handler: (req, res, _next, options) => {
      rateLimitHits.inc({ limiter: 'metrics' });
      res.status(options.statusCode).end('Too many metrics requests');
    },
  });
  app.get('/metrics', metricsRateLimit, (req, res, next) => {
    // Phase 12A A3 — staging/bench : L402_BYPASS=true opens /metrics so the
    // docker-bridge Prometheus can scrape without an API key. Fail-safed
    // against production by the startup guard in config.ts.
    if (config.L402_BYPASS) return next();
    // Require X-API-Key — constant-time compare to avoid timing leak that
    // would let an attacker brute-force the key one byte at a time.
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (safeEqual(apiKey, config.API_KEY)) return next();
    res.status(403).end('Forbidden — X-API-Key required');
  }, async (_req, res) => {
    try {
      const stats = await statsService.getNetworkStats();
      agentsTotal.set(stats.totalAgents);
      channelsTotal.set(stats.totalChannels);

      // Phase 7 C13 — operatorsTotal gauge refresh : countByStatus() est
      // indexé, une requête agrège les 3 buckets.
      const operatorCounts = await operatorRepo.countByStatus();
      operatorsTotal.set({ status: 'verified' }, operatorCounts.verified);
      operatorsTotal.set({ status: 'pending' }, operatorCounts.pending);
      operatorsTotal.set({ status: 'rejected' }, operatorCounts.rejected);

      // Refresh cache freshness gauges at scrape time
      const { getFreshnessReport } = await import('./cache/memoryCache');
      const {
        cacheAgeSeconds,
        cacheRefreshFailures,
        refreshEventLoopGauges,
        refreshCacheRatio,
      } = await import('./middleware/metrics');
      for (const r of getFreshnessReport()) {
        cacheAgeSeconds.set({ key: r.key }, r.ageSec);
        cacheRefreshFailures.set({ key: r.key }, r.consecutiveFailures);
      }

      // Phase 12B B6.3 — snapshot event-loop percentiles + cache hit ratio
      // aligned with the scrape so PromQL sees a coherent view.
      refreshEventLoopGauges();
      await refreshCacheRatio();

      res.setHeader('Content-Type', metricsRegistry.contentType);
      res.end(await metricsRegistry.metrics());
    } catch (err: unknown) {
      // Without a log here, a Prometheus scrape failure is invisible — the
      // target just goes DOWN with no diagnostic in the app logs.
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg }, 'Metrics scrape failed');
      res.status(500).end('Internal Server Error');
    }
  });

  // Rate limiter scoped to API routes only (not /metrics, not static)
  const apiRateLimit = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip ?? '0.0.0.0',
    skip: () => config.L402_BYPASS,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' } },
    // handler fires AFTER the limiter has decided to reject. Counting here
    // gives us a per-limiter 429 count that HTTP status metrics can't
    // distinguish (global vs discovery vs deposit all emit 429).
    handler: (req, res, _next, options) => {
      rateLimitHits.inc({ limiter: 'global' });
      res.status(options.statusCode).json(options.message);
    },
  });

  // API routes — single namespace /api/
  const api = Router();
  api.use(apiRateLimit);

  // Tip header — help agents reduce routing fees by opening a direct channel
  if (config.NODE_PUBKEY) {
    api.use((_req, res, next) => {
      res.setHeader('X-SatRank-Tip', `Save on routing fees - open a channel to ${config.NODE_PUBKEY}`);
      next();
    });
  }
  const balanceAuth = createBalanceAuth(pool, { bypass: config.L402_BYPASS });
  const reportAuth = createReportAuth(pool);

  // Phase 6.4 — self-funding loop tracker. Already constructed earlier in
  // the wiring (right after lndInvoiceService) so DepositController can use
  // it. Logge chaque paid L402 call dans oracle_revenue_log + chaque paid
  // probe spending. Source of truth pour /api/oracle/budget.
  // (oracleBudgetService is in scope from the earlier construction.)

  // Phase 12.14 (2026-05-08) — self-hosted L402 mini-AI gateway. The
  // backend is Claude Haiku 4.5 via Anthropic SDK ; we charge 10 sats
  // per call which covers the upstream cost with a 25-100% margin.
  // L402 native gate — all paid endpoints go through createL402Native.
  // Pricing Mix A+D (2026-04-26): /agent/:publicKeyHash and its sub-routes
  // moved to free discovery, so they are no longer in the pricingMap.
  // POST /intent here is the *fresh* path only — the conditional middleware
  // below short-circuits paidGate when ?fresh=true is absent.
  const paidGate = createL402Native({
    secret: Buffer.from(config.L402_MACAROON_SECRET ?? '', 'hex'),
    lndInvoice: lndInvoiceService,
    pool,
    priceSats: config.L402_DEFAULT_PRICE_SATS,
    ttlSeconds: 30 * 24 * 60 * 60,
    expirySeconds: config.L402_INVOICE_EXPIRY_SECONDS,
    pricingMap: {
      '/probe': 5,
      '/verdicts': 1,
      '/profile/:id': 1,
      '/intent': 2,
    },
    operatorSecret: config.OPERATOR_BYPASS_SECRET,
    onPaidCallSettled: async (route, priceSats, paymentHash) => {
      // Mappe la route au source label du revenue log.
      const sourceMap: Record<string, 'fresh_query' | 'probe_query' | 'verdict_query' | 'profile_query' | 'other'> = {
        '/intent': 'fresh_query',
        '/probe': 'probe_query',
        '/verdicts': 'verdict_query',
        '/profile/:id': 'profile_query',
      };
      const source = sourceMap[route] ?? 'other';
      // Security H1 — payment_hash passé en dédup-key explicite : INSERT
      // ON CONFLICT DO NOTHING empêche le double-revenue si 2 requêtes
      // first-use simultanées passent par le callback avant que
      // token_balance auto-crée le row.
      await oracleBudgetService.logRevenue(
        source,
        priceSats,
        { route },
        paymentHash,
      );
    },
  });

  api.use(createV2Routes(v2Controller, balanceAuth, reportAuth, depositController, paidGate)); // report, deposit, profile (decide/best-route are 410 Gone)
  // Phase 9 C6 — POST /api/probe. Paid endpoint (5 credits per call): the
  // balanceAuth middleware takes 1 credit upstream, probeController debits
  // the remaining 4 atomically. Gated by the L402 native middleware like
  // the other paid routes.
  // Phase 9 C8 — two rate limiters in front of balanceAuth so rejections
  // never consume credits. See src/middleware/probeRateLimit.ts for ordering
  // rationale.
  const probeLimits = createProbeRateLimit({
    perTokenPerHour: config.PROBE_RATE_LIMIT_PER_TOKEN_PER_HOUR,
    globalPerHour: config.PROBE_RATE_LIMIT_GLOBAL_PER_HOUR,
  });
  api.post('/probe', paidGate, probeLimits.perToken, probeLimits.global, balanceAuth, probeController.probe);
  api.use(createPingRoutes(pingController));                           // ping/:pubkey (free, own rate limit)
  // Dedicated tight limiter on /api/version — the response is a thin build-info
  // document with commit hash + build time, so probing it at rate for
  // deploy-detection has no legitimate use. 60/min/IP keeps monitoring happy
  // while closing the high-volume fingerprinting vector.
  const versionRateLimit = rateLimit({
    windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => req.ip ?? '0.0.0.0',
    skip: () => config.L402_BYPASS,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many version requests, please try again later' } },
    handler: (req, res, _next, options) => {
      rateLimitHits.inc({ limiter: 'version' });
      res.status(options.statusCode).json(options.message);
    },
  });
  api.use('/version', versionRateLimit);
  api.use(createHealthRoutes(healthController));          // health, stats, version
  // Free discovery/monitoring endpoints — own rate limits (expensive SQL, no L402 gate)
  // Sim 11 Fix 4 (2026-05-02) — Sim 11 a03 (HARMFUL) hit 429 on 26s spacing:
  // multiple agents sharing the same outgoing NAT IP collectively tripped
  // the per-IP 10/min limit. Two changes:
  //   1. Bump max 10 → 30/min — still aggressive enough to block unauthenticated
  //      SQL fan-out while letting an agent fleet (10 personas × ~3 calls each
  //      per minute = 30) breathe.
  //   2. When a NIP-98 Authorization header is present, key by a stable hash
  //      of its first 32 chars — distinct agents behind the same NAT now
  //      get separate quota buckets. Full crypto verify can't run inline
  //      (sync limit), but the header shape per agent is unique. Defense in
  //      depth: full NIP-98 verify still happens at the controller layer.
  const discoveryRateLimit = rateLimit({
    windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      if (auth && auth.toLowerCase().startsWith('nostr ')) {
        // Phase 12A audit fix MED-1 (2026-05-07) — key on parsed pubkey,
        // not raw header hash. Hashing the raw Authorization header lets a
        // single agent generate distinct rate-limit buckets by varying
        // whitespace, base64 padding, or capitalization in their NIP-98
        // envelope without changing the underlying pubkey. Parsing the
        // pubkey synchronously (no signature verification — that's the
        // controller's job) gives a stable per-pubkey key.
        try {
          const b64 = auth.slice(6).trim();
          const json = Buffer.from(b64, 'base64').toString('utf8');
          const obj = JSON.parse(json) as { pubkey?: string };
          if (typeof obj.pubkey === 'string' && /^[0-9a-f]{64}$/i.test(obj.pubkey)) {
            return `nostr:${obj.pubkey.toLowerCase()}`;
          }
        } catch {
          // Malformed header → fall through to header-hash fallback.
        }
        // Defense-in-depth fallback for malformed Authorization headers.
        return `nostr-malformed:${createHash('sha256').update(auth).digest('hex').slice(0, 32)}`;
      }
      return req.ip ?? '0.0.0.0';
    },
    skip: () => config.L402_BYPASS,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many discovery requests, please try again later' } },
    handler: (req, res, _next, options) => {
      rateLimitHits.inc({ limiter: 'discovery' });
      res.status(options.statusCode).json(options.message);
    },
  });
  api.get('/services', discoveryRateLimit, serviceController.search);
  api.get('/services/best', discoveryRateLimit, serviceController.best);
  api.get('/services/categories', discoveryRateLimit, serviceController.categories);
  // Phase 5 — alias under the /services namespace. Sim 3 agents instinctively
  // hit /api/services/:hash with the endpoint_hash returned by /api/intent
  // and got 404; the canonical route is /api/endpoint/:url_hash, but exposing
  // both makes the discovery flow forgiving without a doc lookup.
  api.get('/services/:url_hash', discoveryRateLimit, endpointController.show);

  // Pricing Mix A+D (2026-04-26) — agent + attestation reads moved to free
  // discovery. createAgentRoutes still receives paidGate/balanceAuth because
  // POST /verdicts (batch) stays paid; the GET /agent/* routes ignore them
  // and use discoveryRateLimit instead.
  api.use(createAgentRoutes(agentController, balanceAuth, paidGate, discoveryRateLimit));
  api.use(createAttestationRoutes(attestationController, balanceAuth, paidGate, discoveryRateLimit));

  // AEPS §8 (2026-05-07) — public, unauthenticated, rate-limited via the
  // global Express middleware. The L1 anchor + signed receipts are the trust
  // root; transparency is the whole point.
  api.use('/aeps', createAepsEvidenceRoutes(aepsEvidenceController));
  // AEPS §10 (2026-05-07) — dispute open/attest/get. NIP-98 enforced by
  // the controller for write paths; GET is public.
  // V2 (2026-05-08) : AEPS dispute + multi-hop gated behind
  // config.AEPS_DISPUTE_ENABLED ; observer routes gated behind
  // config.FORK_DETECTION_ENABLED. Evidence routes (trust root) always on.
  if (config.AEPS_DISPUTE_ENABLED) {
    api.use('/aeps', createAepsDisputeRoutes(aepsDisputeController));
  }
  // AEPS §8.5 (2026-05-07) — permissionless observer routes. POST anchor
  // observation (no auth — observer gets 15% slashing reward via the
  // observed_anchors row regardless of caller identity), GET forks +
  // observations bucket.
  if (config.FORK_DETECTION_ENABLED) {
    api.use('/aeps', createAepsObserverRoutes(aepsObserverController));
  }
  // AEPS §6.3 (2026-05-08) — multi-hop HTLC chain plan/lock/reveal/
  // settle/abort/get. Owner = agent_pubkey from NIP-98 on plan, enforced
  // on subsequent calls. GET is public.
  if (config.AEPS_DISPUTE_ENABLED) {
    api.use('/aeps', createAepsMultiHopRoutes(aepsMultiHopController));
  }

  // /api/intent — Mix A+D conditional gate. Default path = free directory
  // read with staleness disclaimer. ?fresh=true (or { fresh: true } in body)
  // → paidGate + balanceAuth so the resolver can run a synchronous probe of
  // the top-N candidates and guarantee last_probe_age_sec < freshness window.
  // The route path is `/intent`; pricingMap['/intent'] = 2 sats engages only
  // when the wrapper invokes paidGate (not on free calls).
  const conditionalIntentPaidGate: import('express').RequestHandler = (req, res, next) => {
    const wantsFresh = isFreshRequest(req);
    if (!wantsFresh) return next();
    paidGate(req, res, (err: unknown) => {
      if (err) return next(err);
      if (res.headersSent) return; // paidGate emitted 402/401/etc.
      balanceAuth(req, res, next);
    });
  };
  api.post('/intent', discoveryRateLimit, conditionalIntentPaidGate, intentController.resolve);
  api.get('/intent/categories', discoveryRateLimit, intentController.categories);
  // Phase 1 (2026-05-01) — POST /api/fulfill. Strategic pivot endpoint.
  // NIP-98 auth (handled inside the controller, not via balanceAuth, because
  // the agent_pubkey is signed identity here, not an L402 macaroon). Same
  // discoveryRateLimit ceiling as the rest of the surface; per-agent token
  // bucket inside the controller adds a finer-grained guard.
  api.post('/fulfill', discoveryRateLimit, fulfillController.handle);
  // Phase 4 — preview the cost of a fulfill without engagement.
  // Read-only, same rate ceiling as /fulfill.
  api.post('/fulfill/quote', discoveryRateLimit, fulfillController.quote);
  // Phase 6 — second step of hold-invoice mode. Agent paid the invoice
  // returned by /fulfill (mode=hold), now triggers orchestrator.
  api.post('/fulfill/:job_id/execute', discoveryRateLimit, fulfillController.executeHold);
  // Phase 9.2 — capability/session token issuance.
  api.post('/fulfill/session', discoveryRateLimit, fulfillController.issueSession);
  // Phase 2 — operator NIP-98 dispute against Tier 2 refund classifications.
  // Same discoveryRateLimit ceiling. Owner verification + uniqueness +
  // disputability check happen inside the controller.
  // V2 (2026-05-08) : 4 routes gated behind config.CLAIM_ENGINE_ENABLED.
  if (config.CLAIM_ENGINE_ENABLED) {
    api.post('/dispute/:ledger_id', discoveryRateLimit, disputeController.open);
    api.get('/dispute/:dispute_id', discoveryRateLimit, disputeController.show);
    // Phase 7.5 (2026-05-01) — claim dispute (operator-side) + public stats.
    // POST is NIP-98 by the operator owning the bond.
    api.post('/operator/claim/:claim_id/dispute', discoveryRateLimit, claimController.fileDispute);
    api.get('/oracle/claims', discoveryRateLimit, claimController.oracleClaims);
  }
  // Phase 12.5 (2026-05-05) — Golden canary status (public read).
  // Returns the last canary measurement so ops can monitor ranker
  // recall@K from outside the box. 404 when canary is not enabled
  // (no golden-set.json present).
  api.get('/oracle/canary-status', discoveryRateLimit, (_req, res) => {
    if (!goldenCanaryService) {
      res.status(404).json({ error: 'canary_disabled', message: 'GoldenCanary not enabled (no golden-set.json or empty pairs)' });
      return;
    }
    const last = goldenCanaryService.getLastResult();
    if (!last) {
      res.status(202).json({ status: 'pending', message: 'canary has not run yet — boot delay or scheduled tick not fired' });
      return;
    }
    res.status(200).json({ data: last });
  });
  // Phase 10 (2026-05-04) — Operator-side SDK self-registration + dashboard.
  api.post('/operator/register-endpoint', discoveryRateLimit, operatorRegistrationController.register);
  api.get('/operator/:pubkey/dashboard', discoveryRateLimit, operatorRegistrationController.dashboard);
  // Phase 11B.1 (2026-05-04) — Agent bonds : symmetric to operator_bonds.
  // V2 (2026-05-08) : 4 routes gated behind config.AGENT_BONDS_ENABLED.
  if (config.AGENT_BONDS_ENABLED) {
    api.post('/agent/bond/deposit', discoveryRateLimit, agentBondController.deposit);
    api.get('/agent/bond', discoveryRateLimit, agentBondController.status);
    api.post('/agent/bond/:bond_id/freeze', discoveryRateLimit, agentBondController.freeze);
    // Phase 11B.2 (2026-05-04) — Agent reputation : public read keyed by pubkey.
    api.get('/agent/:pubkey/reputation', discoveryRateLimit, agentReputationController.show);
  }
  // Phase 8.3 — evidence receipt for compliance/regulator agents.
  api.get('/fulfill/:job_id/evidence', discoveryRateLimit, evidenceController.show);
  // Phase 3 — JSON Schema registry. POST is NIP-98-gated (operator
  // identity), GET is free for agents to inspect a schema before fulfill.
  // List endpoint exposes the 50 most recent so newcomers can discover
  // canonical schemas.
  api.post('/schemas', discoveryRateLimit, schemaController.register);
  api.get('/schemas', discoveryRateLimit, schemaController.list);
  api.get('/schemas/:hash', discoveryRateLimit, schemaController.show);
  // Phase 1 (2026-05-01) — public observability of the fulfill proxy.
  // Privacy-first: the response only carries aggregate counters, never
  // agent_pubkey or per-job payloads. Agents can use it to confirm the
  // proxy is operational + see the system-wide success rate.
  api.get('/oracle/fulfill', discoveryRateLimit, async (_req, res, next) => {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const [stats, pool, balance] = await Promise.all([
        fulfillJobRepo.statsLast24h(nowSec),
        refundLedgerRepo.windowStats(nowSec - 86400),
        poolAccounting.getBalance(),
      ]);
      const success_rate = stats.total > 0 ? Math.round((stats.success / stats.total) * 1000) / 1000 : null;
      const refund_rate = stats.total > 0 ? Math.round((stats.refunded / stats.total) * 1000) / 1000 : null;
      res.json({
        data: {
          enabled: config.FULFILL_ENABLED,
          window_sec: 86400,
          // Phase 4 — solvency snapshot. circuit_breaker_open flag tells
          // agents whether new /api/fulfill calls are currently accepted.
          // headroom_sats = how much exposure SatRank can still take on
          // before hitting the floor.
          pool: {
            balance_sats: balance.balance_sats,
            min_pool_sats: balance.min_pool_sats,
            headroom_sats: balance.headroom_sats,
            circuit_breaker_open: balance.circuit_breaker_open,
            premium_revenue_sats: balance.premium_revenue_sats,
            sats_absorbed_sats: balance.sats_absorbed_sats,
            premium_revenue_24h: balance.premium_revenue_24h,
            sats_absorbed_24h: balance.sats_absorbed_24h,
          },
          counters: stats,
          success_rate,
          refund_rate,
          // Phase 2 — refund classification breakdown over 24h. Drives
          // operator dashboards + premium calibration cron (Phase 4.5).
          pool_24h: {
            absorbed_events: pool.total_events,
            absorbed_sats: pool.sats_absorbed,
            by_classification: pool.by_classification,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  });
  api.post('/services/register', discoveryRateLimit, serviceRegisterController.register);
  api.patch('/services/register', discoveryRateLimit, serviceRegisterController.update);
  api.delete('/services/register', discoveryRateLimit, serviceRegisterController.remove);
  // Phase 7 — operator registration (NIP-98 gated, rate-limited avec discovery
  // car endpoint à effort de preuve côté claimant — pas de quota L402).
  api.post('/operator/register', discoveryRateLimit, operatorController.register);
  api.get('/operators', discoveryRateLimit, operatorController.list);
  api.get('/operator/:id', discoveryRateLimit, operatorController.show);
  api.get('/endpoint/:url_hash', discoveryRateLimit, endpointController.show);
  api.get('/watchlist', discoveryRateLimit, watchlistController.getChanges);
  // /api/stats/reports — 30-day report-adoption dashboard. Cached 5 min, free.
  api.get('/stats/reports', discoveryRateLimit, reportStatsController.getStats);
  // Phase 6.4 — /api/oracle/budget : public observability du self-funding
  // loop. Lifetime + 30d + 7d revenue/spending + balance + coverage_ratio.
  // Free, rate-limited via discoveryRateLimit. Permet aux agents/auditors
  // de vérifier que l'oracle est durablement financé.
  api.get('/oracle/budget', discoveryRateLimit, async (_req, res, next) => {
    try {
      const snapshot = await oracleBudgetService.getBudgetMultiWindow();
      res.json({ data: snapshot });
    } catch (err) {
      next(err);
    }
  });

  // Phase 6.3 — /api/oracle/assertion/:url_hash : metadata de la kind 30782
  // trust assertion publiée par l'oracle pour un endpoint donné. Permet
  // aux operators de retrouver l'event_id à embarquer dans leur BOLT12
  // offer (TLV custom) et aux agents de fetch directement depuis les
  // relays sans passer par /api/intent.
  //
  // Hint BOLT12 TLV : convention proposée
  //   type 65537 → event_id (32 bytes raw, hex on the wire)
  //   type 65538 → oracle_pubkey (32 bytes raw)
  // Le BOLT12 builder côté operator (FewSats, Alby toolkit, etc.) lit ces
  // valeurs et les ajoute aux TLV custom. Pas de standard IETF —
  // proposition à valider avec les écosystèmes.
  const trustAssertionRepoApi = new TrustAssertionRepository(pool);
  // Phase 7.1 — /api/oracle/peers : list des autres oracles SatRank-
  // compatible découverts via les kind 30784 ingérés sur les relays.
  // Format inclut oracle_pubkey, lnd_pubkey, catalogue_size, latest
  // calibration/assertion event ids, last_seen — l'agent SDK filtre
  // côté client par calibration_error / age / catalogue_size selon ses
  // critères. Pas de filtering trust côté serveur (sovereignty).
  const oraclePeerRepoApi = new OraclePeerRepository(pool);
  api.get('/oracle/peers', discoveryRateLimit, async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50), 200);
      const peers = await oraclePeerRepoApi.list(limit);
      const nowSec = Math.floor(Date.now() / 1000);
      res.json({
        data: {
          peers: peers.map((p) => ({
            oracle_pubkey: p.oracle_pubkey,
            lnd_pubkey: p.lnd_pubkey,
            catalogue_size: p.catalogue_size,
            calibration_event_id: p.calibration_event_id,
            last_assertion_event_id: p.last_assertion_event_id,
            contact: p.contact,
            onboarding_url: p.onboarding_url,
            last_seen: p.last_seen,
            first_seen: p.first_seen,
            age_sec: nowSec - p.first_seen,
            stale_sec: nowSec - p.last_seen,
            latest_announcement_event_id: p.latest_announcement_event_id,
          })),
          count: peers.length,
          limit,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // Phase 9.1 — /api/oracle/peers/:pubkey/calibrations : historique des
  // kind 30783 calibration events publiés par un peer SatRank-compatible.
  // Permet aux clients de vérifier la calibration history d'un peer
  // avant de l'inclure dans une aggregation. Cross-oracle meta-confidence.
  //
  // Audit 2026-04-29 fix — when the requested pubkey is OUR oracle, the
  // peer-calibrations ingestor skips self events (anti-loop) so the peer
  // table is always empty for our own pubkey. Fall back to oracle_calibration_runs
  // (the table we write before publishing) so /api/oracle/peers/<self>/calibrations
  // returns our own calibration history instead of a misleading empty list.
  const peerCalibrationRepoApi = new PeerCalibrationRepository(pool);
  const ownCalibrationRepoApi = new CalibrationRepository(pool);
  // Compute self oracle pubkey once at boot if NOSTR_PRIVATE_KEY is set.
  // Lazy import — keeps the dependency outside the cold path when no key is
  // configured (dev/test).
  let selfOraclePubkeyApi: string | null = null;
  if (config.NOSTR_PRIVATE_KEY) {
    try {
      const { getPublicKey: getPubkey } = require('nostr-tools/pure');
      const { hexToBytes: h2b } = require('@noble/hashes/utils');
      selfOraclePubkeyApi = getPubkey(h2b(config.NOSTR_PRIVATE_KEY));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ error: msg }, 'Failed to derive self oracle pubkey for /oracle/peers/<self>/calibrations fallback');
    }
  }
  api.get('/oracle/peers/:pubkey/calibrations', discoveryRateLimit, async (req, res, next) => {
    try {
      const pubkey = String(req.params.pubkey);
      if (!/^[a-f0-9]{64}$/.test(pubkey)) {
        return res.status(400).json({ error: { code: 'INVALID_PUBKEY', message: 'pubkey must be a 64-char hex Schnorr key' } });
      }
      const limit = Math.min(Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20), 100);
      const isSelf = selfOraclePubkeyApi !== null && pubkey === selfOraclePubkeyApi;
      const calibrationsPayload = isSelf
        ? (await ownCalibrationRepoApi.listRuns(limit)).map((r) => ({
            event_id: r.published_event_id,
            window_start: r.window_start,
            window_end: r.window_end,
            window_days: Math.round((r.window_end - r.window_start) / 86400),
            delta_mean: r.delta_mean,
            delta_median: r.delta_median,
            delta_p95: r.delta_p95,
            n_endpoints: r.n_endpoints,
            n_outcomes: r.n_outcomes,
            observed_at: r.created_at,
          }))
        : (await peerCalibrationRepoApi.listByPeer(pubkey, limit)).map((c) => ({
            event_id: c.event_id,
            window_start: c.window_start,
            window_end: c.window_end,
            window_days: Math.round((c.window_end - c.window_start) / 86400),
            delta_mean: c.delta_mean,
            delta_median: c.delta_median,
            delta_p95: c.delta_p95,
            n_endpoints: c.n_endpoints,
            n_outcomes: c.n_outcomes,
            observed_at: c.observed_at,
          }));
      res.json({
        data: {
          peer_pubkey: pubkey,
          is_self: isSelf,
          calibrations: calibrationsPayload,
          count: calibrationsPayload.length,
          limit,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  api.get('/oracle/assertion/:url_hash', discoveryRateLimit, async (req, res, next) => {
    try {
      const urlHash = String(req.params.url_hash);
      if (!/^[a-f0-9]{64}$/.test(urlHash)) {
        return res.status(400).json({ error: { code: 'INVALID_URL_HASH', message: 'url_hash must be a 64-char hex SHA256' } });
      }
      const record = await trustAssertionRepoApi.findByUrlHash(urlHash);
      if (!record) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No trust assertion published yet for this endpoint. Wait for the next cron tick (≤ 7 days) or check that the endpoint has meaningful stage posteriors.' } });
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const expiresInSec = record.valid_until - nowSec;
      res.json({
        data: {
          endpoint_url_hash: record.endpoint_url_hash,
          kind: 30782,
          event_id: record.event_id,
          oracle_pubkey: record.oracle_pubkey,
          valid_until: record.valid_until,
          expires_in_sec: expiresInSec,
          expired: expiresInSec < 0,
          p_e2e: record.p_e2e,
          meaningful_stages_count: record.meaningful_stages_count,
          calibration_proof_event_id: record.calibration_proof_event_id,
          published_at: record.published_at,
          relays: record.relays,
          bolt12_tlv_hint: {
            note: 'Proposed convention for embedding the trust assertion in a BOLT12 offer. Type IDs not yet IETF-standardized — operators should track future BLIPs.',
            type_event_id: 65537,
            type_oracle_pubkey: 65538,
            event_id_hex: record.event_id,
            oracle_pubkey_hex: record.oracle_pubkey,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  });
  api.get('/openapi.json', (_req, res) => res.json(openapiSpec));
  api.get('/docs', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SatRank API Docs</title>
  <link rel="stylesheet" href="/swagger-ui.css">
  <link rel="stylesheet" href="/swagger-custom.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/swagger-ui-bundle.js"></script>
  <script src="/swagger-init.js"></script>
</body>
</html>`);
  });
  app.use('/api', api);

  // Error handler (must be the last middleware)
  app.use(errorHandler);

  return app;
}

/** Populate the hot caches so the first visitor skips the cold-start cost.
 *  After this runs once, getOrCompute serves everything instantly and refreshes
 *  in the background. All calls are wrapped so a warm-up failure never blocks
 *  startup — Phase 12B: async now that stats/top queries go through pg. */
async function warmUpCaches(
  statsService: StatsService,
  agentController: AgentController,
  trendService: TrendService,
): Promise<void> {
  await runWarmUp(statsService, agentController, trendService, /* initial= */ true);

  // Sim #5 #11: SWR only refreshes on demand — if no traffic hits /api/stats for
  // longer than the TTL, the freshness gauge reports huge staleness (observed
  // 6366s) even though the data would rebuild cheaply. A periodic refresh
  // inside the TTL window keeps the cache warm regardless of traffic.
  const REFRESH_INTERVAL_MS = 4 * 60_000; // just inside the 5-min TTL
  const timer = setInterval(
    () => { void runWarmUp(statsService, agentController, trendService, false); },
    REFRESH_INTERVAL_MS,
  );
  // Don't block process exit for tests / graceful shutdown.
  timer.unref();
}

async function runWarmUp(
  statsService: StatsService,
  agentController: AgentController,
  trendService: TrendService,
  initial: boolean,
): Promise<void> {
  const start = Date.now();
  try {
    await statsService.getNetworkStats();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg }, 'Cache warm-up: getNetworkStats failed');
  }

  // Refresh every (limit × sort_by) combo the health check monitors as critical.
  // The list lives in statsService so a key cannot be declared critical without
  // being warmed — warm-up and CRITICAL_CACHE_KEYS share a single source of truth.
  for (const limit of TOP_WARMUP_LIMITS) {
    for (const sortBy of TOP_SORT_AXES) {
      try {
        const response = await agentController.buildTopResponse(limit, 0, sortBy);
        cacheSetFresh(`agents:top:${limit}:0:${sortBy}`, response, CRITICAL_CACHE_TTL_MS);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ error: msg, limit, sortBy }, 'Cache warm-up: buildTopResponse failed');
      }
    }
  }
  // Movers cache is served from the controller (empty envelope in Phase 3)
  // — no warm-up needed until Commit 8 lands posterior deltas.
  void trendService;

  if (initial) {
    logger.info({ durationMs: Date.now() - start }, 'Cache warm-up complete');
  } else {
    logger.debug({ durationMs: Date.now() - start }, 'Cache periodic refresh complete');
  }
}
