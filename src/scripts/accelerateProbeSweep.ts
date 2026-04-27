#!/usr/bin/env tsx
// Phase 5.5 — accelerateProbeSweep.
//
// One-shot sweep that probes every active endpoint until its per-URL
// streaming posterior crosses n_obs >= 5 (the IS_MEANINGFUL_MIN_N_OBS
// threshold). Phase 5 added the forward-write hook in serviceHealthCrawler
// so per-URL posteriors will diverge over hours/days through cron tier
// rotations, but Sim 4 needs the discrimination signal NOW; this sweep
// brings the full catalogue across the threshold in ~10 minutes.
//
// Cost: ZERO Lightning sats. We only check the 402 challenge response
// (parse-only — no payment, no preimage). The probe is identical to what
// `serviceHealthCrawler.probeBatch` does on every cron tick, so this
// script is functionally a "force the cron loop to run NOW for every
// endpoint that hasn't accumulated enough observations yet".
//
// Strategy:
//   1. List active endpoints whose URL-keyed posterior has n_obs < 5.
//   2. Group by host; serial within a host (1 req/sec rate limit) but
//      parallel across hosts so llm402.ai's 100 entries don't block
//      grid.ptsolutions.io's 74.
//   3. For each endpoint:
//      - Check its current n_obs and compute how many MORE probes are
//        needed (target = TARGET_N_OBS = 5).
//      - For each needed probe: call fetchSafeExternal with the endpoint's
//        http_method, classify the response (402 with L402 challenge =
//        success; 5xx / network = failure; non-conforming = log + skip).
//      - Feed each classified outcome into BayesianScoringService.ingestStreaming
//        keyed by endpointHash(url) — exactly the same code path the
//        production crawler uses post-Phase-5.
//   4. Stop when:
//      - Every targeted endpoint has reached >= TARGET_N_OBS, OR
//      - WALL_CLOCK_BUDGET_MS elapses (default 30 min).
//
// Run via:
//   docker exec satrank-api node /app/dist/scripts/accelerateProbeSweep.js
import { getPool, closePools } from '../database/connection';
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
import { fetchSafeExternal, SsrfBlockedError } from '../utils/ssrf';
import { endpointHash } from '../utils/urlCanonical';
import { logger } from '../logger';

const TARGET_N_OBS = 5;
const WALL_CLOCK_BUDGET_MS = 30 * 60 * 1000;
const PER_HOST_GAP_MS = 1000;
const FETCH_TIMEOUT_MS = 5000;

interface EndpointRow {
  url: string;
  agentHash: string | null;
  httpMethod: 'GET' | 'POST';
  currentNObs: number;
}

interface SweepSummary {
  scanned: number;
  /** Endpoints already at or above TARGET_N_OBS at start (skipped). */
  alreadyMeaningful: number;
  /** Endpoints whose URL hash had no streaming row before the sweep —
   *  the sweep ingests one observation, the row is created by ingestStreaming. */
  missingRowsCreated: number;
  probesAttempted: number;
  successes: number;
  failures: number;
  /** Probes that returned non-402 / non-5xx (200, 401, 404, 405, 406…) —
   *  not a Lightning probe outcome, do NOT feed into the posterior. */
  nonConforming: number;
  /** SSRF guard rejections (rare; should be 0 for an audited catalogue). */
  ssrfBlocked: number;
  /** Endpoints that crossed n_obs >= TARGET_N_OBS by the end of the sweep. */
  crossedThreshold: number;
  /** Endpoints still below threshold when the sweep terminated (budget ran
   *  out, or the endpoint kept returning non-conforming responses). */
  stillBelowThreshold: number;
  hostsTouched: number;
  elapsedSec: number;
}

async function listEndpointsNeedingProbes(
  pool: import('pg').Pool,
  streamingRepo: EndpointStreamingPosteriorRepository,
): Promise<EndpointRow[]> {
  // Direct query on service_endpoints — bypasses the 100-row clamp baked
  // into ServiceEndpointRepository.findServices. The full catalogue is ~345
  // rows so the round-trips are negligible.
  const { rows } = await pool.query<{ url: string; agent_hash: string | null }>(
    `SELECT url, agent_hash FROM service_endpoints
       WHERE deprecated = FALSE
         AND agent_hash IS NOT NULL
         AND source IN ('402index', 'l402directory', 'self_registered')`,
  );
  const out: EndpointRow[] = [];
  for (const svc of rows) {
    const decayed = await streamingRepo.readAllSourcesDecayed(
      endpointHash(svc.url),
      Math.floor(Date.now() / 1000),
    );
    const currentNObs = decayed.probe.totalIngestions
      + decayed.report.totalIngestions
      + decayed.paid.totalIngestions;
    out.push({
      url: svc.url,
      agentHash: svc.agent_hash,
      httpMethod: 'GET', // The catalogue does not persist http_method per row;
                        // serviceHealthCrawler also defaults to GET. POST is
                        // attempted as fallback inside the discovery probe but
                        // serviceHealthCrawler probes don't need to discover —
                        // they just classify the 402 response.
      currentNObs: Number(currentNObs),
    });
  }
  return out;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

interface ProbeOutcome {
  kind: 'success' | 'failure' | 'non_conforming' | 'ssrf_blocked';
  status?: number;
}

async function probeChallenge(url: string, method: 'GET' | 'POST'): Promise<ProbeOutcome> {
  try {
    const resp = await fetchSafeExternal(url, {
      method,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'SatRank-Phase55-Sweep/1.0',
        'Accept': 'application/json, */*;q=0.5',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    if (resp.status === 402) {
      const wwwAuth = resp.headers.get('www-authenticate') ?? '';
      // Validate the response actually carries an L402 challenge. Without
      // this gate, an x402 endpoint that also returns 402 would record a
      // bogus success.
      if (/L402.+invoice="lnbc[a-z0-9]+"/i.test(wwwAuth)) {
        return { kind: 'success', status: 402 };
      }
      // 402 but no parsable BOLT11 — same bucket the registry crawler uses
      // for `invalid_l402_no_bolt11`. Don't feed this into the posterior;
      // it would mis-attribute a parser issue as a reliability signal.
      return { kind: 'non_conforming', status: 402 };
    }
    if (resp.status >= 500 && resp.status < 600) {
      return { kind: 'failure', status: resp.status };
    }
    return { kind: 'non_conforming', status: resp.status };
  } catch (err: unknown) {
    if (err instanceof SsrfBlockedError) return { kind: 'ssrf_blocked' };
    // Network errors (timeout, ECONNREFUSED, DNS) are real provider-side
    // failures and SHOULD lower the posterior — same as serviceHealthCrawler.
    return { kind: 'failure' };
  }
}

async function sweepOneHost(
  hostUrls: EndpointRow[],
  scoring: BayesianScoringService,
  summary: SweepSummary,
  deadline: number,
): Promise<void> {
  for (const ep of hostUrls) {
    if (Date.now() > deadline) return;
    const needed = Math.max(0, TARGET_N_OBS - ep.currentNObs);
    if (needed === 0) {
      summary.alreadyMeaningful++;
      continue;
    }
    const startNObs = ep.currentNObs;
    let observed = 0;
    for (let i = 0; i < needed; i++) {
      if (Date.now() > deadline) break;
      summary.probesAttempted++;
      const outcome = await probeChallenge(ep.url, ep.httpMethod);
      switch (outcome.kind) {
        case 'success':
          summary.successes++;
          observed++;
          if (ep.agentHash) {
            await scoring.ingestStreaming({
              success: true,
              timestamp: Math.floor(Date.now() / 1000),
              source: 'probe',
              endpointHash: endpointHash(ep.url),
              serviceHash: endpointHash(ep.url),
              operatorId: ep.agentHash,
              nodePubkey: ep.agentHash,
            });
          }
          break;
        case 'failure':
          summary.failures++;
          observed++;
          if (ep.agentHash) {
            await scoring.ingestStreaming({
              success: false,
              timestamp: Math.floor(Date.now() / 1000),
              source: 'probe',
              endpointHash: endpointHash(ep.url),
              serviceHash: endpointHash(ep.url),
              operatorId: ep.agentHash,
              nodePubkey: ep.agentHash,
            });
          }
          break;
        case 'non_conforming':
          summary.nonConforming++;
          // Don't feed into posterior — bail out of this endpoint after 2
          // consecutive non-conforming responses to avoid wasting budget on
          // a misclassified row.
          if (i === 0) {
            const second = await probeChallenge(ep.url, ep.httpMethod);
            summary.probesAttempted++;
            if (second.kind === 'non_conforming') {
              summary.nonConforming++;
              break;
            }
            // The retry succeeded/failed — fall back to that outcome.
            i--; // Re-loop with the already-spent probe accounted for above.
          }
          break;
        case 'ssrf_blocked':
          summary.ssrfBlocked++;
          break;
      }
      // Pace the next call to the same host. Even when we bail out we
      // keep the host pacing so the next endpoint on this host respects
      // the 1 req/sec contract.
      if (i < needed - 1) await sleep(PER_HOST_GAP_MS);
    }
    if (startNObs + observed >= TARGET_N_OBS) {
      summary.crossedThreshold++;
    } else {
      summary.stillBelowThreshold++;
    }
    if (summary.probesAttempted % 50 === 0 && summary.probesAttempted > 0) {
      logger.info(
        { ...summary, elapsedSec: Math.round((Date.now() - START_AT) / 1000) },
        'Phase 5.5 sweep progress',
      );
    }
    // Pace before moving to the next endpoint on this host.
    if (Date.now() < deadline) await sleep(PER_HOST_GAP_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let START_AT = 0;

async function main(): Promise<void> {
  START_AT = Date.now();
  const deadline = START_AT + WALL_CLOCK_BUDGET_MS;
  const pool = getPool();
  try {
    logger.info('Phase 5.5 accelerateProbeSweep — starting');
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
    const scoring = new BayesianScoringService(
      endpointStreamingRepo,
      serviceStreamingRepo,
      operatorStreamingRepo,
      nodeStreamingRepo,
      routeStreamingRepo,
      endpointBucketsRepo,
      serviceBucketsRepo,
      operatorBucketsRepo,
      nodeBucketsRepo,
      routeBucketsRepo,
    );

    const endpoints = await listEndpointsNeedingProbes(pool, endpointStreamingRepo);
    const byHost = new Map<string, EndpointRow[]>();
    for (const ep of endpoints) {
      const h = hostnameOf(ep.url);
      if (!h) continue;
      const list = byHost.get(h) ?? [];
      list.push(ep);
      byHost.set(h, list);
    }

    const summary: SweepSummary = {
      scanned: endpoints.length,
      alreadyMeaningful: 0,
      missingRowsCreated: 0,
      probesAttempted: 0,
      successes: 0,
      failures: 0,
      nonConforming: 0,
      ssrfBlocked: 0,
      crossedThreshold: 0,
      stillBelowThreshold: 0,
      hostsTouched: byHost.size,
      elapsedSec: 0,
    };

    logger.info(
      { endpoints: endpoints.length, hosts: byHost.size },
      'Phase 5.5 sweep — endpoint inventory built; starting per-host pipelines',
    );

    // Parallel across hosts, serial within a host.
    await Promise.all(
      Array.from(byHost.values()).map((hostUrls) =>
        sweepOneHost(hostUrls, scoring, summary, deadline),
      ),
    );

    summary.elapsedSec = Math.round((Date.now() - START_AT) / 1000);
    logger.info(summary, 'Phase 5.5 sweep — complete');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await closePools();
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      'Phase 5.5 sweep failed',
    );
    process.exit(1);
  });
}

export {
  TARGET_N_OBS,
  PER_HOST_GAP_MS,
  WALL_CLOCK_BUDGET_MS,
  probeChallenge,
};
export type { ProbeOutcome, SweepSummary };
