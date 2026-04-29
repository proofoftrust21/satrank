// Periodic HTTP health checker for known service endpoints.
//
// Axe 1 — runs in 3 independent tiers driven by `last_intent_query_at`:
//   hot  : queried < 2h ago,  re-probed if last check older than 1h
//   warm : queried < 24h ago, re-probed if last check older than 6h
//   cold : queried >= 24h or never, re-probed if last check older than 24h
//
// `run()` keeps the legacy "all stale" sweep for tests and ad-hoc invocations;
// production scheduling calls `runTier(tier)` from three separate timers.
import { logger } from '../logger';
import { sha256 } from '../utils/crypto';
import { fetchSafeExternal, SsrfBlockedError } from '../utils/ssrf';
import { canonicalizeUrl, endpointHash } from '../utils/urlCanonical';
import { windowBucket } from '../utils/dualWriteLogger';
import type { AgentRepository } from '../repositories/agentRepository';
import type { ProbeTier, ServiceEndpoint, ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { DualWriteMode, TransactionRepository } from '../repositories/transactionRepository';
import type { DualWriteEnrichment, DualWriteLogger } from '../utils/dualWriteLogger';
import type { Transaction } from '../types';
import type { BayesianScoringService } from '../services/bayesianScoringService';
import type { InvoiceValidityService } from '../services/invoiceValidityService';
import {
  type EndpointStagePosteriorsRepository,
  STAGE_CHALLENGE,
} from '../repositories/endpointStagePosteriorsRepository';
import { parseL402Challenge } from '../utils/l402HeaderParser';

const CHECK_RATE_MS = 200; // 5 checks/sec
const FETCH_TIMEOUT_MS = 3000;

const TIER_LIMITS: Record<ProbeTier, number> = {
  hot: 200,
  warm: 200,
  cold: 500,
};

export interface ServiceHealthRunResult {
  checked: number;
  healthy: number;
  down: number;
  tier?: ProbeTier;
}

export class ServiceHealthCrawler {
  constructor(
    private repo: ServiceEndpointRepository,
    private txRepo?: TransactionRepository,
    private dualWriteMode: DualWriteMode = 'off',
    private dualWriteLogger?: DualWriteLogger,
    private agentRepo?: AgentRepository,
    /** Phase 5 — when wired, every probe outcome is written into the
     *  endpoint-keyed streaming posterior so /api/intent can surface a real
     *  per-URL Bayesian block instead of falling through to the operator
     *  prior. Optional so test harnesses that don't care about scoring can
     *  still construct the crawler with the legacy 5-arg form. */
    private bayesianService?: BayesianScoringService,
    /** Phase 5.11 — when wired, every 402 response triggers a local BOLT11
     *  decode + validation; the outcome feeds endpoint_stage_posteriors
     *  stage=2 (invoice). Coût zéro sat. Optional pour back-compat tests. */
    private invoiceValidityService?: InvoiceValidityService,
    /** Phase 5.14 / Sim 7 follow-up — when wired, every probe outcome is
     *  recorded into endpoint_stage_posteriors stage=1 (challenge). Success
     *  iff status==402 AND a parseable L402 challenge was returned. Without
     *  this, stage 1 stays empty and stage_posteriors is absent on every
     *  candidate served by /api/intent. Optional for back-compat tests. */
    private stagePosteriorsRepo?: EndpointStagePosteriorsRepository,
  ) {}

  /** Production entrypoint — probe a single tier. */
  async runTier(tier: ProbeTier): Promise<ServiceHealthRunResult> {
    const stale = await this.repo.findStaleByTier(tier, TIER_LIMITS[tier]);
    return this.probeBatch(stale, tier);
  }

  /** Legacy single-sweep — kept for tests and one-off scripts. */
  async run(): Promise<ServiceHealthRunResult> {
    const stale = await this.repo.findStale(3, 1800, 500);
    return this.probeBatch(stale);
  }

  private async probeBatch(stale: ServiceEndpoint[], tier?: ProbeTier): Promise<ServiceHealthRunResult> {
    const result: ServiceHealthRunResult = { checked: 0, healthy: 0, down: 0, tier };
    if (stale.length === 0) return result;
    logger.info({ tier, candidates: stale.length }, 'Service health crawl starting');

    for (const endpoint of stale) {
      let status = 0;
      let latencyMs = 0;
      let healthy = false;
      let wwwAuthenticate: string | null = null;

      try {
        // SSRF guard via fetchSafeExternal — single connect-time DNS lookup
        // validated inline (no TOCTOU). Attacker-controlled URL resolving to
        // 169.254.169.254/10.0.0.1 is rejected at the Agent lookup hook.
        // Audit r3 — utiliser endpoint.http_method (du catalogue 402index).
        // Avant ce fix, le crawler GET-uniquement causait 405 Method Not
        // Allowed sur les ~50 endpoints POST-only (llm402.ai principalement),
        // qui se propageait dans last_http_status puis cascadait à tous les
        // consommateurs (paid probe runner, freshProbeService, etc.).
        const method = endpoint.http_method ?? 'GET';
        const start = Date.now();
        const resp = await fetchSafeExternal(endpoint.url, {
          method,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: {
            'User-Agent': 'SatRank-HealthCheck/1.0',
            ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(method === 'POST' ? { body: '{}' } : {}),
        });
        latencyMs = Date.now() - start;
        status = resp.status;
        healthy = resp.status === 402 || (resp.status >= 200 && resp.status < 300);
        // Phase 5.11 — capture WWW-Authenticate pour stage 2. Le body n'est
        // jamais consommé (SatRank n'est pas un proxy de contenu).
        if (status === 402) {
          wwwAuthenticate = resp.headers.get('www-authenticate');
        }
      } catch (err: unknown) {
        if (err instanceof SsrfBlockedError) {
          logger.debug({ url: endpoint.url, reason: err.message }, 'Health crawler skipped URL (SSRF)');
        }
        status = 0;
        latencyMs = 0;
        healthy = false;
      }

      await this.repo.upsert(endpoint.agent_hash, endpoint.url, status, latencyMs);
      if (healthy) result.healthy++;
      else result.down++;

      await this.dualWriteProbeTx(endpoint, healthy);
      // Phase 5 — feed the per-endpoint streaming posterior so /api/intent's
      // Bayesian block discriminates per URL, not per operator. Skipped when
      // bayesianService isn't wired (test harnesses that don't care about scoring).
      await this.ingestProbeStreaming(endpoint, healthy);
      // Phase 5.14 / Sim 7 follow-up — Stage 1 challenge. Records every
      // probe outcome (including dead hosts and non-402 responses) so the
      // 5-stage decomposition has a populated first stage. Without this
      // write, /api/intent omits stage_posteriors on every candidate.
      await this.observeChallenge(endpoint, status, wwwAuthenticate);
      // Phase 5.11 — Stage 2 invoice validity. Quand le probe a retourné 402
      // ET un challenge L402 parseable, on décode + valide la BOLT11 et
      // alimente endpoint_stage_posteriors stage=2. Coût : 0 sat (decode
      // local). Skipped si l'invoiceValidityService n'est pas wiré (tests).
      await this.observeInvoiceValidity(endpoint, status, wwwAuthenticate);

      result.checked++;
      if (result.checked < stale.length) {
        await new Promise(resolve => setTimeout(resolve, CHECK_RATE_MS));
      }
    }

    logger.info({ ...result }, 'Service health crawl complete');
    return result;
  }

  /** Phase 5.14 / Sim 7 follow-up — Stage 1 challenge. Records whether the
   *  endpoint returned a valid L402 challenge (HTTP 402 + parseable
   *  WWW-Authenticate carrying both macaroon and invoice). Every probe
   *  outcome contributes one observation: dead hosts, 5xx, 200, and 4xx
   *  all count as `success=false`; only a clean 402 + parseable challenge
   *  counts as `success=true`. Without this write, stage_posteriors stays
   *  absent on every candidate (Sim 7 finding: 10/10 agents flagged
   *  stage_posteriors=absent). No-op when stagePosteriorsRepo isn't wired
   *  (test harnesses). Never throws — failures log and the probe loop
   *  continues. */
  private async observeChallenge(
    endpoint: ServiceEndpoint,
    status: number,
    wwwAuthenticate: string | null,
  ): Promise<void> {
    if (!this.stagePosteriorsRepo) return;
    const challenge = status === 402 ? parseL402Challenge(wwwAuthenticate) : null;
    const success = challenge !== null;
    // Security audit (Finding 7) — clamp `status` to the IANA HTTP range
    // before interpolating into outcome_label. A misbehaving / hostile
    // server could theoretically return a non-standard status code that
    // pollutes the calibration audit log. Outside [100, 599] → 'http_unknown'.
    const isValidHttpStatus = Number.isInteger(status) && status >= 100 && status <= 599;
    const outcomeLabel = success
      ? 'l402_challenge_ok'
      : status === 402
        ? 'l402_challenge_unparseable'
        : status === 0
          ? 'host_unreachable'
          : isValidHttpStatus
            ? `http_${status}`
            : 'http_unknown';
    try {
      await this.stagePosteriorsRepo.observe(
        {
          endpoint_url: endpoint.url,
          stage: STAGE_CHALLENGE,
          success,
          outcome_label: outcomeLabel,
        },
      );
    } catch (err) {
      logger.warn(
        { url: endpoint.url, error: err instanceof Error ? err.message : String(err) },
        'Stage 1 challenge observation failed (non-fatal)',
      );
    }
  }

  /** Phase 5.11 — Stage 2 invoice validity. Décodage + validation locale
   *  d'une BOLT11 extraite du challenge L402, écrit le résultat dans
   *  endpoint_stage_posteriors stage=2. Pas d'I/O réseau (le decode est
   *  local), donc on ne ralentit pas le tier rate-limit du health crawler.
   *
   *  No-op quand :
   *  - invoiceValidityService non wiré (tests sans le service)
   *  - status != 402 (pas de challenge à valider)
   *  - WWW-Authenticate absent ou non parseable comme L402
   *  La méthode n'avale jamais une exception : si le service échoue, on
   *  log et on continue le probe loop. */
  private async observeInvoiceValidity(
    endpoint: ServiceEndpoint,
    status: number,
    wwwAuthenticate: string | null,
  ): Promise<void> {
    if (!this.invoiceValidityService) return;
    if (status !== 402) return;
    const challenge = parseL402Challenge(wwwAuthenticate);
    if (!challenge) return;
    try {
      await this.invoiceValidityService.observe({
        endpoint_url: endpoint.url,
        invoice: challenge.invoice,
        advertisedPriceSats: endpoint.service_price_sats,
      });
    } catch (err) {
      logger.warn(
        { url: endpoint.url, error: err instanceof Error ? err.message : String(err) },
        'Stage 2 invoice validity observation failed (non-fatal)',
      );
    }
  }

  /** Phase 5 — endpoint-keyed streaming posterior write. probeCrawler.ts
   *  feeds operator-keyed posteriors via LN keysend probes; this is the
   *  parallel write for HTTP probes. Without it, /api/intent's Bayesian
   *  read keyed by `endpointHash(url)` falls through to the prior cascade
   *  on every endpoint, defeating per-URL discrimination (Sim 3 root cause).
   *
   *  Idempotency: streaming_posteriors are additive on (target_hash, source);
   *  duplicate writes from overlapping cron ticks are tolerated by the
   *  τ=7d decay applied at read time.
   *
   *  Skipped when bayesianService isn't injected (test contexts) or when the
   *  endpoint has no operator hash (synthesized probe rows can't satisfy
   *  the operator FK in the daily_buckets table). */
  private async ingestProbeStreaming(endpoint: ServiceEndpoint, success: boolean): Promise<void> {
    if (!this.bayesianService) return;
    if (!endpoint.agent_hash) return;
    try {
      const urlHash = endpointHash(endpoint.url);
      await this.bayesianService.ingestStreaming({
        success,
        timestamp: Math.floor(Date.now() / 1000),
        source: 'probe',
        endpointHash: urlHash,
        serviceHash: urlHash,
        operatorId: endpoint.agent_hash,
        nodePubkey: endpoint.agent_hash,
      });
    } catch (err) {
      logger.warn(
        { url: endpoint.url, error: err instanceof Error ? err.message : String(err) },
        'Probe streaming ingest failed — endpoint posterior unchanged',
      );
    }
  }

  /** Compose a synthetic probe-tx row and dispatch through insertWithDualWrite
   *  per docs/PHASE-1-DESIGN.md §4. Skipped when:
   *   - mode is `off` — probes are a *new* writer for `transactions`; preserving
   *     pre-v31 behavior in off mode means we don't introduce rows here at all.
   *   - endpoint has no operator (agent_hash IS NULL) — can't satisfy NOT NULL
   *     FKs on sender_hash/receiver_hash. Matches §1.1's `operator_id` NULL
   *     rule: if we don't know the operator we don't attribute probe observations.
   *   - txRepo wasn't injected — allows the crawler to be used in contexts
   *     (tests, one-off scripts) that don't care about tx writes.
   *   - same tx_id already exists for today — daily-granularity idempotence,
   *     so overlapping cron ticks / restarts don't double-count a probe. */
  private async dualWriteProbeTx(endpoint: ServiceEndpoint, healthy: boolean): Promise<void> {
    if (this.dualWriteMode === 'off') return;
    if (!this.txRepo) return;
    if (!endpoint.agent_hash) return;

    // Purge-safe: the stale-sweep may remove an `agents` row whose
    // `public_key_hash` is still referenced by a `service_endpoints.agent_hash`.
    // Without this guard the legacy INSERT throws `FOREIGN KEY constraint failed`
    // (sender_hash → agents.public_key_hash), which is caught below but costs a
    // roundtrip per probe and pollutes logs on every cycle. Skip silently
    // when the operator is gone; observed on `l402.lndyn.com/*`, `satring.com/*`.
    if (this.agentRepo && !(await this.agentRepo.findByHash(endpoint.agent_hash))) {
      logger.warn(
        { url: endpoint.url, agent_hash: endpoint.agent_hash },
        'Probe dual-write skipped — endpoint.agent_hash references purged agent',
      );
      return;
    }

    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const bucket = windowBucket(timestamp);
      const canonical = canonicalizeUrl(endpoint.url);
      const txId = sha256(`probe:${canonical}:${bucket}`);

      if (await this.txRepo.findById(txId)) return;

      const tx: Transaction = {
        tx_id: txId,
        sender_hash: endpoint.agent_hash,
        receiver_hash: endpoint.agent_hash,
        amount_bucket: 'micro',
        timestamp,
        payment_hash: sha256(`${txId}:ph`),
        preimage: null,
        status: healthy ? 'verified' : 'failed',
        protocol: 'l402',
      };

      const enrichment: DualWriteEnrichment = {
        endpoint_hash: endpointHash(endpoint.url),
        operator_id: endpoint.agent_hash,
        source: 'probe',
        window_bucket: bucket,
      };

      await this.txRepo.insertWithDualWrite(tx, enrichment, this.dualWriteMode, 'serviceProbes', this.dualWriteLogger);
    } catch (err) {
      // One malformed URL or DB hiccup must not abort the health probe loop.
      // The legacy service_endpoints row was already persisted above.
      logger.error(
        { url: endpoint.url, error: err instanceof Error ? err.message : String(err) },
        'Probe dual-write failed',
      );
    }
  }
}
