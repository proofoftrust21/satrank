// Decision engine — GO / NO-GO with success probability
// Transforms SatRank from information service to decision infrastructure
import type { AgentRepository } from '../repositories/agentRepository';
import type { AttestationRepository } from '../repositories/attestationRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { LndGraphClient } from '../crawler/lndGraphClient';
import type { ScoringService } from './scoringService';
import type { TrendService } from './trendService';
import type { RiskService } from './riskService';
import type { VerdictService } from './verdictService';
import type { SurvivalService } from './survivalService';
import type { DecideResponse, ServiceHealth, VerdictFlag, Verdict, ConfidenceLevel, PathfindingResult } from '../types';
import { SEVEN_DAYS_SEC } from '../utils/constants';
import { logger } from '../logger';
const EMPIRICAL_THRESHOLD = 10; // min data points before using empirical basis

// If the most recent probe for the target is older than this, fire a live
// queryRoutes before answering. Default: 30 minutes (matches the probe
// crawler cycle). Override via DECIDE_REPROBE_STALE_SEC env var.
const REPROBE_STALE_SEC = Number(process.env.DECIDE_REPROBE_STALE_SEC ?? '1800');
const REPROBE_TIMEOUT_MS = 5_000;

// Default probe amount for feeBudget calculation when amountSats is not provided
const DEFAULT_AMOUNT_SATS = 1000;
// Fee budget as fraction of the payment amount — fees above this cap P_path.feeScore to 0
const FEE_BUDGET_RATIO = 0.01; // 1%

// Sigmoid function: maps score (0-100) to probability (0-1), centered at 50
function sigmoid(score: number, midpoint: number = 50, steepness: number = 0.1): number {
  return 1 / (1 + Math.exp(-steepness * (score - midpoint)));
}

// P_path — quality of the Lightning path from caller to target.
// Continuous 0-1 signal derived from the pathfinding result. Captures HOW WELL
// the path is, not just whether it exists (which is P_routable's binary job).
//   - hopPenalty: 1-hop direct channel = 1.0, degrades ~8% per extra hop
//   - altBonus:   more alternative routes = higher reliability
//   - feeScore:   lower fee relative to amount = better path
function computePathQuality(pathfinding: PathfindingResult | null, amountSats: number | undefined): number {
  // No pathfinding data (caller unknown, LND down) — return neutral
  if (!pathfinding) return 0.5;
  // No route found — worst case
  if (!pathfinding.reachable) return 0.0;

  const hops = pathfinding.hops ?? 1;
  const alternatives = pathfinding.alternatives ?? 1;
  const feeMsat = pathfinding.estimatedFeeMsat ?? 0;

  // Hop penalty: 1 hop = 1.0, each additional hop costs 8%, floor at 0.12
  const hopPenalty = Math.max(0.12, 1 - (hops - 1) * 0.08);

  // Alternative routes bonus: 1 route = 0.9, 2 routes = 1.0, 3+ = 1.0
  const altBonus = Math.min(1, 0.8 + alternatives * 0.1);

  // Fee score: 0 fee = 1.0, fee >= budget = 0.0
  const feeBudgetMsat = (amountSats ?? DEFAULT_AMOUNT_SATS) * FEE_BUDGET_RATIO * 1000;
  const feeScore = feeBudgetMsat > 0
    ? 1 - Math.min(1, feeMsat / feeBudgetMsat)
    : 1.0;

  return hopPenalty * 0.5 + altBonus * 0.3 + feeScore * 0.2;
}

export interface DecideServiceOptions {
  agentRepo: AgentRepository;
  attestationRepo: AttestationRepository;
  scoringService: ScoringService;
  trendService: TrendService;
  riskService: RiskService;
  verdictService: VerdictService;
  probeRepo?: ProbeRepository;
  lndClient?: LndGraphClient;
  survivalService?: SurvivalService;
  serviceEndpointRepo?: ServiceEndpointRepository;
}

// SSRF protection: block private/loopback IPs, server's own IP, and resolve DNS before fetch
const PRIVATE_IP_RE = /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0|169\.254\.\d+\.\d+)$/;
const BLOCKED_HOSTNAMES = /^(localhost|\[::1?\]|\[::ffff:.+\])$/i;
const SERVER_IP = process.env.SERVER_IP ?? '178.104.108.108';
const SERVICE_HEALTH_CACHE_TTL_SEC = 1800; // 30 min
const SERVICE_HEALTH_TIMEOUT_MS = 3000;
const SERVICE_HEALTH_NONBLOCK_MS = 500;

function isIpBlocked(ip: string): boolean {
  return PRIVATE_IP_RE.test(ip) || ip === SERVER_IP || ip === '0.0.0.0';
}

function isUrlBlocked(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    if (!['http:', 'https:'].includes(u.protocol)) return true;
    if (BLOCKED_HOSTNAMES.test(u.hostname)) return true;
    if (isIpBlocked(u.hostname)) return true;
    // Block IPv6-mapped IPv4 (extract and check the IPv4 part)
    const mapped = u.hostname.match(/^\[::ffff:([\d.]+)\]$/i);
    if (mapped && isIpBlocked(mapped[1])) return true;
    return false;
  } catch { return true; }
}

/** Resolve hostname to IP and verify it's not private (anti-DNS-rebinding) */
async function resolveAndCheck(urlStr: string): Promise<boolean> {
  if (isUrlBlocked(urlStr)) return true;
  try {
    const { resolve4 } = await import('dns/promises');
    const hostname = new URL(urlStr).hostname;
    // Skip resolution for raw IPs (already checked above)
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;
    const ips = await resolve4(hostname);
    return ips.some(ip => isIpBlocked(ip));
  } catch { return false; } // DNS failure = allow (could be transient)
}

function classifyHttp(status: number): 'healthy' | 'degraded' | 'down' {
  if (status >= 200 && status < 300) return 'healthy';  // 2xx success
  if (status === 301 || status === 302 || status === 307 || status === 308) return 'healthy'; // normal redirects
  if (status === 402) return 'healthy';                  // L402 paywall gate
  if (status === 401 || status === 403) return 'degraded'; // access issue
  if (status >= 400 && status < 500) return 'degraded';  // other client errors
  return 'down';                                         // 5xx, 0 (timeout/DNS), anything else
}

export class DecideService {
  private agentRepo: AgentRepository;
  private attestationRepo: AttestationRepository;
  private scoringService: ScoringService;
  private verdictService: VerdictService;
  private probeRepo?: ProbeRepository;
  private lndClient?: LndGraphClient;
  private survivalService?: SurvivalService;
  private serviceEndpointRepo?: ServiceEndpointRepository;

  constructor(opts: DecideServiceOptions) {
    this.agentRepo = opts.agentRepo;
    this.attestationRepo = opts.attestationRepo;
    this.scoringService = opts.scoringService;
    this.verdictService = opts.verdictService;
    this.probeRepo = opts.probeRepo;
    this.lndClient = opts.lndClient;
    this.survivalService = opts.survivalService;
    this.serviceEndpointRepo = opts.serviceEndpointRepo;
  }

  async decide(
    targetHash: string,
    callerHash: string,
    amountSats?: number,
    pathfindingSourcePubkey?: string,
    serviceUrl?: string,
  ): Promise<DecideResponse> {
    const startMs = Date.now();

    // Mark as hot node for priority probing
    this.agentRepo.touchLastQueried(targetHash);

    // Get the full verdict (reuses pathfinding, personal trust, flags, risk profile)
    const verdictResult = await this.verdictService.getVerdict(targetHash, callerHash, pathfindingSourcePubkey);

    // P_trust — sigmoid of the trust score, centered at 50
    const scoreResult = this.scoringService.getScore(targetHash);
    const pTrust = sigmoid(scoreResult.total);

    // P_routable — is there a Lightning route from caller to target?
    let pRoutable = 0.5; // default when no pathfinding data
    if (verdictResult.pathfinding) {
      pRoutable = verdictResult.pathfinding.reachable ? 1.0 : 0.0;
    }

    // P_available — probe uptime over 7 days, with on-demand re-probe
    // when the latest probe is stale. This ensures the agent gets a fresh
    // reachability signal, not a cached one from hours ago.
    let pAvailable = 0.5;
    let lastProbeAgeMs: number | null = null;
    if (this.probeRepo) {
      const lastProbe = this.probeRepo.findLatest(targetHash);
      const now = Math.floor(Date.now() / 1000);
      const probeAgeSec = lastProbe ? now - lastProbe.probed_at : Infinity;

      // Re-probe on-demand if the last probe is stale and LND is available.
      // Escalates through the multi-amount tiers (1k, 10k, 100k, 1M) so the
      // agent gets a fresh maxRoutableAmount at the scale of their payment,
      // not just the default 1k. Stops at the first tier that fails.
      if (probeAgeSec > REPROBE_STALE_SEC && this.lndClient) {
        const agent = this.agentRepo.findByHash(targetHash);
        if (agent?.public_key) {
          const tiers = [1_000, 10_000, 100_000, 1_000_000];
          const requestedAmount = amountSats ?? 1000;
          // Only escalate up to (and including) the tier that covers the requested amount.
          // If amountSats=500k, test 1k/10k/100k/1M. If amountSats=5k, test 1k/10k.
          const relevantTiers = tiers.filter(t => t <= Math.max(requestedAmount, 1000) * 2 || t === tiers[0]);
          try {
            for (const tier of relevantTiers) {
              const response = await Promise.race([
                this.lndClient.queryRoutes(agent.public_key, tier, pathfindingSourcePubkey),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('reprobe timeout')), REPROBE_TIMEOUT_MS)),
              ]);
              const routes = response.routes ?? [];
              const reachable = routes.length > 0;
              this.probeRepo.insert({
                target_hash: targetHash,
                probed_at: now,
                reachable: reachable ? 1 : 0,
                latency_ms: null,
                hops: reachable ? routes[0].hops.length : null,
                estimated_fee_msat: reachable ? (parseInt(routes[0].total_fees_msat, 10) || 0) : null,
                failure_reason: reachable ? null : 'no_route',
                probe_amount_sats: tier,
              });
              if (!reachable) break; // stop escalating on first failure
            }
            logger.info({ targetHash: targetHash.slice(0, 12), tiers: relevantTiers.length, probeAgeSec }, 'On-demand multi-amount re-probe completed');
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn({ targetHash: targetHash.slice(0, 12), error: msg }, 'On-demand re-probe failed');
          }
        }
      }

      // Read uptime from all probes (including the one we just inserted)
      const uptime = this.probeRepo.computeUptime(targetHash, SEVEN_DAYS_SEC);
      if (uptime !== null) {
        pAvailable = uptime;
      }
      // Re-read the latest probe (may be the fresh one we just inserted)
      const freshProbe = this.probeRepo.findLatest(targetHash);
      if (freshProbe) {
        lastProbeAgeMs = Math.round(Date.now() - freshProbe.probed_at * 1000);
      }
    }

    // Max routable amount from multi-amount probing (1k/10k/100k/1M sats).
    // null when no multi-amount data is available (node not hot enough to
    // trigger higher-tier probes, or first cycle after deploy).
    const maxRoutableAmount = this.probeRepo
      ? this.probeRepo.findMaxRoutableAmount(targetHash, SEVEN_DAYS_SEC)
      : null;

    // P_empirical — historical success rate from reports
    const { rate: empiricalRate, dataPoints, uniqueReporters } = this.attestationRepo.weightedSuccessRate(targetHash);
    // Require both sufficient data points AND diverse reporters to avoid single-agent self-reporting
    const hasEmpirical = dataPoints >= EMPIRICAL_THRESHOLD && uniqueReporters >= 5;
    const pEmpirical = hasEmpirical ? empiricalRate : pTrust; // fallback to proxy

    // P_path — path quality from the caller's position in the graph
    const pPath = computePathQuality(verdictResult.pathfinding, amountSats);

    // Composite success rate
    const basis: 'proxy' | 'empirical' = hasEmpirical ? 'empirical' : 'proxy';
    let successRate: number;
    if (hasEmpirical) {
      // Empirical mode: P_empirical dominates, P_path personalises, P_trust is safety net
      successRate = pEmpirical * 0.40 + pPath * 0.25 + pAvailable * 0.15 + pTrust * 0.10 + pRoutable * 0.10;
    } else {
      // Proxy mode: trust score + path quality drive the decision
      successRate = pTrust * 0.30 + pPath * 0.30 + pAvailable * 0.20 + pRoutable * 0.20;
    }

    // Clamp to [0, 1]
    successRate = Math.max(0, Math.min(1, successRate));

    // Service health check (non-blocking)
    let serviceHealth: ServiceHealth | null = null;
    if (serviceUrl && this.serviceEndpointRepo && !(await resolveAndCheck(serviceUrl))) {
      serviceHealth = await this.checkServiceHealth(targetHash, serviceUrl, startMs);
    }

    // GO decision: successRate >= 0.5 AND no critical flags AND service not down
    const hasCritical = verdictResult.flags.includes('fraud_reported') ||
      verdictResult.flags.includes('negative_reputation');
    const serviceDown = serviceHealth?.status === 'down';
    const go = successRate >= 0.5 && !hasCritical && !serviceDown;

    // reportedSuccessRate — raw empirical rate, null when insufficient data
    const reportedSuccessRate = hasEmpirical ? Math.round(empiricalRate * 1000) / 1000 : null;

    const survival = this.survivalService
      ? this.survivalService.compute(targetHash)
      : { score: 100, prediction: 'stable' as const, signals: { scoreTrajectory: 'no data', probeStability: 'no data', gossipFreshness: 'no data' } };

    // Fee volatility: 0-100 internal score mapped to 0-1 index (1 = stable).
    // Returns null when no fee data is available for this target.
    const feeStabilityRaw = this.scoringService.computeFeeStability(targetHash);
    const targetFeeStability = feeStabilityRaw === 50 ? null : Math.round(feeStabilityRaw) / 100;

    // Tag pathfinding result with the source node used
    const pathfinding = verdictResult.pathfinding
      ? { ...verdictResult.pathfinding, sourceNode: pathfindingSourcePubkey ?? 'satrank' }
      : null;

    const latencyMs = Date.now() - startMs;

    return {
      go,
      successRate: Math.round(successRate * 1000) / 1000,
      components: {
        trustScore: Math.round(pTrust * 1000) / 1000,
        routable: Math.round(pRoutable * 1000) / 1000,
        available: Math.round(pAvailable * 1000) / 1000,
        empirical: Math.round(pEmpirical * 1000) / 1000,
        pathQuality: Math.round(pPath * 1000) / 1000,
      },
      basis,
      confidence: scoreResult.confidence,
      verdict: verdictResult.verdict,
      flags: verdictResult.flags,
      pathfinding,
      riskProfile: verdictResult.riskProfile,
      reason: verdictResult.reason,
      survival,
      targetFeeStability,
      maxRoutableAmount,
      reportedSuccessRate,
      lastProbeAgeMs,
      serviceHealth,
      latencyMs,
    };
  }

  /** Check HTTP health of a service URL. Non-blocking: if cache miss takes > 500ms,
   *  returns { status: 'checking' } immediately and finishes in background. */
  private async checkServiceHealth(agentHash: string, url: string, decideStartMs: number): Promise<ServiceHealth> {
    // 1. Check cache
    const cached = this.serviceEndpointRepo!.findByUrl(url);
    const now = Math.floor(Date.now() / 1000);
    const servicePriceSats = cached?.service_price_sats ?? null;

    if (cached?.last_checked_at && (now - cached.last_checked_at) < SERVICE_HEALTH_CACHE_TTL_SEC) {
      const uptimeRatio = cached.check_count >= 3
        ? Math.round((cached.success_count / cached.check_count) * 1000) / 1000
        : null;
      return {
        url,
        status: cached.last_http_status ? classifyHttp(cached.last_http_status) : 'unknown',
        httpCode: cached.last_http_status,
        latencyMs: cached.last_latency_ms,
        uptimeRatio,
        lastCheckedAt: cached.last_checked_at,

        servicePriceSats,
      };
    }

    // 2. Live check with non-blocking timeout
    const elapsed = Date.now() - decideStartMs;
    const remainingBudget = SERVICE_HEALTH_NONBLOCK_MS - elapsed;

    if (remainingBudget <= 50) {
      // Already spent too long — fire background check, return 'checking'
      this.fireBackgroundCheck(agentHash, url);
      return { url, status: 'checking', httpCode: null, latencyMs: null, uptimeRatio: null, lastCheckedAt: null, servicePriceSats };
    }

    // Race: live check vs budget timeout
    const checkPromise = this.doHttpCheck(agentHash, url);
    const timeoutPromise = new Promise<null>(resolve => setTimeout(() => resolve(null), remainingBudget));

    const result = await Promise.race([checkPromise, timeoutPromise]);
    if (result) return result;

    // Budget exceeded — the check continues in background, return 'checking'
    checkPromise.catch(() => {}); // prevent unhandled rejection
    return { url, status: 'checking', httpCode: null, latencyMs: null, uptimeRatio: null, lastCheckedAt: null, servicePriceSats };
  }

  private fireBackgroundCheck(agentHash: string, url: string): void {
    this.doHttpCheck(agentHash, url).catch((err: unknown) => {
      logger.warn({ url, error: err instanceof Error ? err.message : String(err) }, 'Background service health check failed');
    });
  }

  private async doHttpCheck(agentHash: string, url: string): Promise<ServiceHealth> {
    try {
      const start = Date.now();
      const resp = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(SERVICE_HEALTH_TIMEOUT_MS),
        headers: { 'User-Agent': 'SatRank-HealthCheck/1.0' },
        redirect: 'manual', // Don't follow redirects to prevent SSRF via 301→private IP
      });
      const latencyMs = Date.now() - start;
      const httpCode = resp.status;

      this.serviceEndpointRepo!.upsert(agentHash, url, httpCode, latencyMs);
      const updated = this.serviceEndpointRepo!.findByUrl(url);
      const uptimeRatio = updated && updated.check_count >= 3
        ? Math.round((updated.success_count / updated.check_count) * 1000) / 1000
        : null;


      const ep = this.serviceEndpointRepo!.findByUrl(url);
      return { url, status: classifyHttp(httpCode), httpCode, latencyMs, uptimeRatio, lastCheckedAt: Math.floor(Date.now() / 1000), servicePriceSats: ep?.service_price_sats ?? null };
    } catch {
      this.serviceEndpointRepo!.upsert(agentHash, url, 0, 0);

      return { url, status: 'down', httpCode: null, latencyMs: null, uptimeRatio: null, lastCheckedAt: Math.floor(Date.now() / 1000), servicePriceSats: null };
    }
  }
}
