// Phase 8 — C5 : scheduler périodique pour les kinds 30382 (node) et 30383
// (endpoint). Scanne les streaming_posteriors, détermine via shouldRepublish()
// quelles entités méritent une (re)publication, puis délègue au
// NostrMultiKindPublisher et met à jour le cache nostr_published_events.
//
// Règles :
//   - scan les posteriors modifiés depuis `(now - scanWindowSec)` — fenêtre
//     glissante avec overlap pour éviter de rater une mise à jour à cheval
//     sur deux scans.
//   - dedup par entityId (les 3 rows source/entityId partagent le même event)
//   - un échec sur une entité n'interrompt pas le scan — on log et on continue.
//
// Service endorsements (kind 30384) restent hors-scope C5 : pas encore de
// table de métadonnées `services` fournissant `name` — pré-requis pour
// construire un template 30384 non-bégayant. Réintroduit quand la Phase 9
// (service registry) livre la shape.
import type Database from 'better-sqlite3';
import type { BayesianSource } from '../config/bayesianConfig';
import {
  CONVERGENCE_MIN_SOURCES,
  CONVERGENCE_P_THRESHOLD,
  DEFAULT_PRIOR_ALPHA,
  DEFAULT_PRIOR_BETA,
  TAU_DAYS,
  UNKNOWN_MIN_N_OBS,
  RISKY_P_THRESHOLD,
  RISKY_CI95_HIGH_MAX,
  UNKNOWN_CI95_INTERVAL_MAX,
  SAFE_P_THRESHOLD,
  SAFE_CI95_LOW_MIN,
  SAFE_MIN_N_OBS,
} from '../config/bayesianConfig';
import { computePosterior } from '../utils/betaBinomial';
import type {
  EndpointStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  DecayedPosterior,
} from '../repositories/streamingPosteriorRepository';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { OperatorService } from '../services/operatorService';
import type {
  NostrPublishedEventsRepository,
  PublishedEntityType,
  PublishedEventRow,
} from '../repositories/nostrPublishedEventsRepository';
import type { NostrMultiKindPublisher, PublishResult } from './nostrMultiKindPublisher';
import {
  payloadHash,
  buildEndpointEndorsement,
  buildNodeEndorsement,
  type EndpointEndorsementState,
  type NodeEndorsementState,
  type EndorsementSource,
  type EventTemplate,
  type VerdictFlashState,
} from './eventBuilders';
import { shouldRepublish } from './shouldRepublish';
import { computeAdvisoryReport } from '../services/advisoryService';
import type { Verdict, AdvisoryLevel } from '../types/index';
import { logger } from '../logger';
import {
  multiKindFlashesTotal,
  multiKindRepublishSkippedTotal,
} from '../middleware/metrics';

const DEFAULT_SCAN_WINDOW_SEC = 900; // 15 min

export interface SchedulerOptions {
  /** Fenêtre temporelle (secondes) — entités dont last_update_ts > (now - window). */
  scanWindowSec?: number;
  /** Limite par type d'entité pour éviter un scan monstre sur premier boot. */
  maxPerType?: number;
}

export interface EntityScanResult {
  entityType: PublishedEntityType;
  scanned: number;
  published: number;
  skippedNoChange: number;
  /** Entités où shouldRepublish() a dit oui mais le payload_hash du template
   *  calculé correspond exactement à celui en cache — évite un round-trip
   *  publish pour rien (e.g. shifts sous le seuil d'arrondi des tags). */
  skippedHashIdentical: number;
  errors: number;
  firstPublish: number;
  /** Flashes éphémères kind 20900 émis pour les transitions de verdict. */
  flashesPublished: number;
  /** Flashes qui auraient dû être émis mais aucun relai n'a ack. */
  flashErrors: number;
}

export interface ScanResult {
  startedAt: number;
  finishedAt: number;
  perType: EntityScanResult[];
}

export class NostrMultiKindScheduler {
  constructor(
    private publisher: NostrMultiKindPublisher,
    private endpointStreaming: EndpointStreamingPosteriorRepository,
    private nodeStreaming: NodeStreamingPosteriorRepository,
    private publishedEvents: NostrPublishedEventsRepository,
    private serviceEndpointRepo: ServiceEndpointRepository | null,
    private operatorService: OperatorService | null,
    private db: Database.Database,
  ) {}

  async runScan(nowSec: number, opts: SchedulerOptions = {}): Promise<ScanResult> {
    const started = nowSec;
    const window = opts.scanWindowSec ?? DEFAULT_SCAN_WINDOW_SEC;
    const cutoff = nowSec - window;

    const perType: EntityScanResult[] = [];
    perType.push(await this.scanEndpoints(nowSec, cutoff, opts.maxPerType));
    perType.push(await this.scanNodes(nowSec, cutoff, opts.maxPerType));

    return {
      startedAt: started,
      finishedAt: Math.floor(Date.now() / 1000),
      perType,
    };
  }

  private async scanEndpoints(nowSec: number, cutoff: number, limit?: number): Promise<EntityScanResult> {
    const result: EntityScanResult = {
      entityType: 'endpoint',
      scanned: 0,
      published: 0,
      skippedNoChange: 0,
      skippedHashIdentical: 0,
      errors: 0,
      firstPublish: 0,
      flashesPublished: 0,
      flashErrors: 0,
    };

    const ids = this.listModifiedEntities('endpoint_streaming_posteriors', 'url_hash', cutoff, limit);
    result.scanned = ids.length;

    for (const urlHash of ids) {
      try {
        const snapshot = this.buildEndpointSnapshot(urlHash, nowSec);
        if (!snapshot) { result.errors++; continue; }
        const previous = this.publishedEvents.getLastPublished('endpoint', urlHash);
        const decision = shouldRepublish(
          previous ? toShouldRepublishSnapshot(previous) : null,
          {
            verdict: snapshot.verdict,
            advisory_level: snapshot.advisory_level,
            p_success: snapshot.p_success,
            n_obs_effective: snapshot.n_obs,
          },
        );
        if (!decision.shouldRepublish) {
          result.skippedNoChange++;
          multiKindRepublishSkippedTotal.inc({ reason: 'no_change' });
          continue;
        }

        // Fast-path C7 : si le template calculé hash exactement au même
        // payload_hash que ce qu'on a en cache, pas la peine de republier —
        // les relais vont de toute façon ignorer (NIP-33 replaceable = même
        // kind+pubkey+d-tag → ils gardent le plus récent created_at, mais
        // notre payload est identique).
        const expectedHash = payloadHash(buildTemplateForHash(snapshot, 'endpoint'));
        if (previous && previous.payload_hash === expectedHash) {
          result.skippedHashIdentical++;
          multiKindRepublishSkippedTotal.inc({ reason: 'hash_identical' });
          continue;
        }

        if (decision.reason === 'first_publish') result.firstPublish++;

        const published = await this.publishEndpoint(snapshot, nowSec);
        if (!published.anySuccess) {
          result.errors++;
          logger.warn({ urlHash: urlHash.slice(0, 12), reason: decision.reason, acks: published.acks.length }, 'multi-kind endpoint publish: no relay ack');
          continue;
        }
        result.published++;
        logger.info({
          urlHash: urlHash.slice(0, 12),
          eventId: published.eventId.slice(0, 12),
          reason: decision.reason,
          verdict: snapshot.verdict,
          advisory: snapshot.advisory_level,
        }, 'multi-kind endpoint republished');

        // Flash éphémère kind 20900 sur transition de verdict.
        // Best-effort : on ne rollback pas la publication 30383 si le flash rate.
        if (isVerdictTransition(previous?.verdict ?? null, snapshot.verdict)) {
          const flashOk = await this.emitFlash({
            entity_type: 'endpoint',
            entity_id: snapshot.url_hash,
            from_verdict: previous?.verdict ?? null,
            to_verdict: snapshot.verdict,
            p_success: snapshot.p_success,
            ci95_low: snapshot.ci95_low,
            ci95_high: snapshot.ci95_high,
            n_obs: snapshot.n_obs,
            advisory_level: snapshot.advisory_level,
            risk_score: snapshot.risk_score,
            source: snapshot.source,
            time_constant_days: snapshot.time_constant_days,
            last_update: snapshot.last_update,
            operator_id: snapshot.operator_id,
          }, nowSec);
          if (flashOk) result.flashesPublished++;
          else result.flashErrors++;
        }
      } catch (err: unknown) {
        result.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ urlHash: urlHash.slice(0, 12), error: msg }, 'multi-kind endpoint scan error');
      }
    }
    return result;
  }

  private async scanNodes(nowSec: number, cutoff: number, limit?: number): Promise<EntityScanResult> {
    const result: EntityScanResult = {
      entityType: 'node',
      scanned: 0,
      published: 0,
      skippedNoChange: 0,
      skippedHashIdentical: 0,
      errors: 0,
      firstPublish: 0,
      flashesPublished: 0,
      flashErrors: 0,
    };

    const ids = this.listModifiedEntities('node_streaming_posteriors', 'pubkey', cutoff, limit);
    result.scanned = ids.length;

    for (const pubkey of ids) {
      try {
        const snapshot = this.buildNodeSnapshot(pubkey, nowSec);
        if (!snapshot) { result.errors++; continue; }
        const previous = this.publishedEvents.getLastPublished('node', pubkey);
        const decision = shouldRepublish(
          previous ? toShouldRepublishSnapshot(previous) : null,
          {
            verdict: snapshot.verdict,
            advisory_level: snapshot.advisory_level,
            p_success: snapshot.p_success,
            n_obs_effective: snapshot.n_obs,
          },
        );
        if (!decision.shouldRepublish) {
          result.skippedNoChange++;
          multiKindRepublishSkippedTotal.inc({ reason: 'no_change' });
          continue;
        }

        // Fast-path C7 : same story côté node — bypass si template identique.
        const expectedHash = payloadHash(buildTemplateForHash(snapshot, 'node'));
        if (previous && previous.payload_hash === expectedHash) {
          result.skippedHashIdentical++;
          multiKindRepublishSkippedTotal.inc({ reason: 'hash_identical' });
          continue;
        }

        if (decision.reason === 'first_publish') result.firstPublish++;

        const published = await this.publishNode(snapshot, nowSec);
        if (!published.anySuccess) {
          result.errors++;
          logger.warn({ pubkey: pubkey.slice(0, 12), reason: decision.reason, acks: published.acks.length }, 'multi-kind node publish: no relay ack');
          continue;
        }
        result.published++;
        logger.info({
          pubkey: pubkey.slice(0, 12),
          eventId: published.eventId.slice(0, 12),
          reason: decision.reason,
          verdict: snapshot.verdict,
          advisory: snapshot.advisory_level,
        }, 'multi-kind node republished');

        if (isVerdictTransition(previous?.verdict ?? null, snapshot.verdict)) {
          const flashOk = await this.emitFlash({
            entity_type: 'node',
            entity_id: snapshot.node_pubkey,
            from_verdict: previous?.verdict ?? null,
            to_verdict: snapshot.verdict,
            p_success: snapshot.p_success,
            ci95_low: snapshot.ci95_low,
            ci95_high: snapshot.ci95_high,
            n_obs: snapshot.n_obs,
            advisory_level: snapshot.advisory_level,
            risk_score: snapshot.risk_score,
            source: snapshot.source,
            time_constant_days: snapshot.time_constant_days,
            last_update: snapshot.last_update,
            operator_id: snapshot.operator_id,
          }, nowSec);
          if (flashOk) result.flashesPublished++;
          else result.flashErrors++;
        }
      } catch (err: unknown) {
        result.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ pubkey: pubkey.slice(0, 12), error: msg }, 'multi-kind node scan error');
      }
    }
    return result;
  }

  /** Récupère les entity_id distincts dont au moins une row a `last_update_ts >= cutoff`. */
  private listModifiedEntities(table: string, idColumn: string, cutoff: number, limit?: number): string[] {
    const sql = limit
      ? `SELECT DISTINCT ${idColumn} FROM ${table} WHERE last_update_ts >= ? ORDER BY last_update_ts DESC LIMIT ?`
      : `SELECT DISTINCT ${idColumn} FROM ${table} WHERE last_update_ts >= ? ORDER BY last_update_ts DESC`;
    const rows = (limit ? this.db.prepare(sql).all(cutoff, limit) : this.db.prepare(sql).all(cutoff)) as Array<Record<string, string>>;
    return rows.map((r) => r[idColumn]);
  }

  /** Construit le state complet d'un endpoint — verdict + advisory + posterior +
   *  enrichissements (url, operator_id, category, price_sats). */
  private buildEndpointSnapshot(urlHash: string, nowSec: number): EndpointEndorsementState | null {
    const decayed = this.endpointStreaming.readAllSourcesDecayed(urlHash, nowSec);
    const { combined, perSource } = combineDecayed(decayed);
    if (combined.nObs === 0) return null;

    const verdict = this.computeVerdict(combined, perSource);
    const advisory = computeAdvisoryReport({
      bayesian: {
        p_success: combined.pSuccess,
        ci95_low: combined.ci95Low,
        ci95_high: combined.ci95High,
        n_obs: combined.nObs,
      },
    });
    const source = dominantSource(decayed);
    const lastUpdate = Math.max(decayed.probe.lastUpdateTs, decayed.report.lastUpdateTs, decayed.paid.lastUpdateTs);

    const endpointRow = this.serviceEndpointRepo?.findByUrlHash(urlHash) ?? null;
    const operatorLookup = this.operatorService?.resolveOperatorForEndpoint(urlHash) ?? null;
    const operatorId = operatorLookup?.status === 'verified' ? operatorLookup.operatorId : null;

    return {
      url_hash: urlHash,
      url: endpointRow?.url ?? `urn:satrank:endpoint:${urlHash.slice(0, 16)}`,
      verdict,
      p_success: combined.pSuccess,
      ci95_low: combined.ci95Low,
      ci95_high: combined.ci95High,
      n_obs: combined.nObs,
      advisory_level: advisory.advisory_level,
      risk_score: advisory.risk_score,
      source,
      time_constant_days: TAU_DAYS,
      last_update: lastUpdate,
      operator_id: operatorId,
      price_sats: endpointRow?.service_price_sats ?? null,
      median_latency_ms: endpointRow?.last_latency_ms ?? null,
      category: endpointRow?.category ?? null,
      service_name: endpointRow?.name ?? null,
    };
  }

  private buildNodeSnapshot(pubkey: string, nowSec: number): NodeEndorsementState | null {
    const decayed = this.nodeStreaming.readAllSourcesDecayed(pubkey, nowSec);
    const { combined, perSource } = combineDecayed(decayed);
    if (combined.nObs === 0) return null;

    const verdict = this.computeVerdict(combined, perSource);
    const advisory = computeAdvisoryReport({
      bayesian: {
        p_success: combined.pSuccess,
        ci95_low: combined.ci95Low,
        ci95_high: combined.ci95High,
        n_obs: combined.nObs,
      },
    });
    const source = dominantSource(decayed);
    const lastUpdate = Math.max(decayed.probe.lastUpdateTs, decayed.report.lastUpdateTs, decayed.paid.lastUpdateTs);

    const operatorLookup = this.operatorService?.resolveOperatorForNode(pubkey) ?? null;
    const operatorId = operatorLookup?.status === 'verified' ? operatorLookup.operatorId : null;

    return {
      node_pubkey: pubkey,
      verdict,
      p_success: combined.pSuccess,
      ci95_low: combined.ci95Low,
      ci95_high: combined.ci95High,
      n_obs: combined.nObs,
      advisory_level: advisory.advisory_level,
      risk_score: advisory.risk_score,
      source,
      time_constant_days: TAU_DAYS,
      last_update: lastUpdate,
      operator_id: operatorId,
    };
  }

  private computeVerdict(
    combined: { pSuccess: number; ci95Low: number; ci95High: number; nObs: number },
    perSource: Record<BayesianSource, { pSuccess: number; nObs: number }>,
  ): Verdict {
    // Mirror de BayesianScoringService.computeVerdict — même logique, mais
    // inlined ici pour éviter d'avoir à instancier le scoringService (qui
    // demande 10 repos alors qu'on n'utilise qu'une fonction pure).
    const { pSuccess, ci95Low, ci95High, nObs } = combined;
    const interval = ci95High - ci95Low;

    if (nObs < UNKNOWN_MIN_N_OBS) return 'INSUFFICIENT';
    if (pSuccess < RISKY_P_THRESHOLD) return 'RISKY';
    if (ci95High < RISKY_CI95_HIGH_MAX) return 'RISKY';
    if (interval > UNKNOWN_CI95_INTERVAL_MAX) return 'UNKNOWN';

    const aboveThreshold: BayesianSource[] = [];
    for (const s of ['probe', 'report', 'paid'] as const) {
      if (perSource[s].nObs > 0 && perSource[s].pSuccess >= CONVERGENCE_P_THRESHOLD) aboveThreshold.push(s);
    }
    const converged = aboveThreshold.length >= CONVERGENCE_MIN_SOURCES;

    if (pSuccess >= SAFE_P_THRESHOLD && ci95Low >= SAFE_CI95_LOW_MIN && nObs >= SAFE_MIN_N_OBS && converged) {
      return 'SAFE';
    }
    return 'UNKNOWN';
  }

  /** Émet un flash kind 20900 — best effort. Renvoie true si au moins un relai ack. */
  private async emitFlash(state: VerdictFlashState, nowSec: number): Promise<boolean> {
    try {
      const result = await this.publisher.publishVerdictFlash(state, nowSec);
      if (result.anySuccess) {
        multiKindFlashesTotal.inc({ type: state.entity_type });
        logger.info({
          entityType: state.entity_type,
          entityId: state.entity_id.slice(0, 12),
          from: state.from_verdict ?? 'NONE',
          to: state.to_verdict,
          eventId: result.eventId.slice(0, 12),
        }, 'verdict flash broadcasted');
        return true;
      }
      logger.warn({
        entityType: state.entity_type,
        entityId: state.entity_id.slice(0, 12),
        acks: result.acks.length,
      }, 'verdict flash: no relay ack');
      return false;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({
        entityType: state.entity_type,
        entityId: state.entity_id.slice(0, 12),
        error: msg,
      }, 'verdict flash publish error');
      return false;
    }
  }

  private async publishEndpoint(state: EndpointEndorsementState, nowSec: number): Promise<PublishResult> {
    const result = await this.publisher.publishEndpointEndorsement(state, nowSec);
    if (result.anySuccess) {
      const template = buildTemplateForHash(state, 'endpoint');
      this.publishedEvents.recordPublished({
        entityType: 'endpoint',
        entityId: state.url_hash,
        eventId: result.eventId,
        eventKind: result.kind,
        publishedAt: result.publishedAt,
        payloadHash: payloadHash(template),
        verdict: state.verdict,
        advisoryLevel: state.advisory_level,
        pSuccess: state.p_success,
        nObsEffective: state.n_obs,
      });
    }
    return result;
  }

  private async publishNode(state: NodeEndorsementState, nowSec: number): Promise<PublishResult> {
    const result = await this.publisher.publishNodeEndorsement(state, nowSec);
    if (result.anySuccess) {
      const template = buildTemplateForHash(state, 'node');
      this.publishedEvents.recordPublished({
        entityType: 'node',
        entityId: state.node_pubkey,
        eventId: result.eventId,
        eventKind: result.kind,
        publishedAt: result.publishedAt,
        payloadHash: payloadHash(template),
        verdict: state.verdict,
        advisoryLevel: state.advisory_level,
        pSuccess: state.p_success,
        nObsEffective: state.n_obs,
      });
    }
    return result;
  }
}

// --- Helpers purs ---------------------------------------------------------

/** Transition de verdict digne d'un flash. Le premier publish d'une entité
 *  (previous = null) ne compte pas comme une transition — aucun observateur
 *  n'avait de state précédent à contredire. Les transitions vers ou depuis
 *  INSUFFICIENT non plus : c'est du bruit d'échantillonnage, pas un signal. */
export function isVerdictTransition(from: Verdict | null, to: Verdict): boolean {
  if (from === null) return false;
  if (from === to) return false;
  if (from === 'INSUFFICIENT' || to === 'INSUFFICIENT') return false;
  return true;
}

function combineDecayed(decayed: Record<BayesianSource, DecayedPosterior>): {
  combined: { pSuccess: number; ci95Low: number; ci95High: number; nObs: number };
  perSource: Record<BayesianSource, { pSuccess: number; nObs: number }>;
} {
  let wSuccess = 0;
  let wFailure = 0;
  const perSource: Record<BayesianSource, { pSuccess: number; nObs: number }> = {
    probe: { pSuccess: 0, nObs: 0 },
    report: { pSuccess: 0, nObs: 0 },
    paid: { pSuccess: 0, nObs: 0 },
  };
  for (const src of ['probe', 'report', 'paid'] as const) {
    const d = decayed[src];
    if (d.totalIngestions === 0) continue;
    const alphaExcess = Math.max(0, d.posteriorAlpha - DEFAULT_PRIOR_ALPHA);
    const betaExcess = Math.max(0, d.posteriorBeta - DEFAULT_PRIOR_BETA);
    wSuccess += alphaExcess;
    wFailure += betaExcess;
    const post = computePosterior(DEFAULT_PRIOR_ALPHA, DEFAULT_PRIOR_BETA, alphaExcess, betaExcess);
    perSource[src] = { pSuccess: post.pSuccess, nObs: d.nObsEffective };
  }
  const combined = computePosterior(DEFAULT_PRIOR_ALPHA, DEFAULT_PRIOR_BETA, wSuccess, wFailure);
  return {
    combined: {
      pSuccess: combined.pSuccess,
      ci95Low: combined.ci95Low,
      ci95High: combined.ci95High,
      nObs: combined.nObs,
    },
    perSource,
  };
}

function dominantSource(decayed: Record<BayesianSource, DecayedPosterior>): EndorsementSource {
  let best: EndorsementSource = 'probe';
  let bestTs = -1;
  for (const src of ['probe', 'report', 'paid'] as const) {
    const d = decayed[src];
    if (d.totalIngestions === 0) continue;
    if (d.lastUpdateTs > bestTs) { bestTs = d.lastUpdateTs; best = src; }
  }
  return best;
}

function toShouldRepublishSnapshot(row: PublishedEventRow): {
  verdict: Verdict;
  advisory_level: AdvisoryLevel;
  p_success: number;
  n_obs_effective: number;
} {
  // Colonnes nullables en DB (pour les rows qu'on aurait persistées avant C5)
  // mais en pratique C5 remplit toujours → fallback neutre pour robustesse.
  return {
    verdict: row.verdict ?? 'INSUFFICIENT',
    advisory_level: row.advisory_level ?? 'green',
    p_success: row.p_success ?? 0,
    n_obs_effective: row.n_obs_effective ?? 0,
  };
}

/** Rebuild un template identique à celui publié — sert au calcul de payloadHash. */
function buildTemplateForHash(
  state: EndpointEndorsementState | NodeEndorsementState,
  type: 'endpoint' | 'node',
): EventTemplate {
  // Le payloadHash est indépendant de created_at — on passe le last_update
  // comme substitut stable pour ne pas avoir besoin du created_at exact.
  return type === 'endpoint'
    ? buildEndpointEndorsement(state as EndpointEndorsementState, state.last_update)
    : buildNodeEndorsement(state as NodeEndorsementState, state.last_update);
}
