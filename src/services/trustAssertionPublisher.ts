// Phase 6.2 — publisher kind 30782 trust assertions.
//
// Pour chaque endpoint actif avec ≥1 stage meaningful (n_obs effectif ≥
// IS_MEANINGFUL_MIN_N_OBS), construit + publie un Nostr event signé,
// addressable replaceable (NIP-33) sur d-tag = url_hash. Permet aux agents
// de :
//   - obtenir le trust signal via Nostr-only (sans hit /api/intent)
//   - composer les outputs oracle (Agent A passe l'event à Agent B,
//     B vérifie offline via verify_assertion MCP — Phase 6.0)
//   - chaîner trust → calibration via le tag calibration_proof
//
// Le content du kind 30782 contient les 5 stages individuels + p_e2e
// composé + bornes pessimist/optimist, exactement comme l'API JSON.
// Tags addressable + key signals + valid_until + calibration_proof.
//
// Cron weekly partagé avec calibration. valid_until = published_at + 7d.
// Idempotence : skip si déjà publié il y a < 6 jours.
//
// Pas de payment, pas de cost — la publication est gratuite côté oracle.
import { logger } from '../logger';
import type { NostrMultiKindPublisher } from '../nostr/nostrMultiKindPublisher';
import type {
  ServiceEndpoint,
  ServiceEndpointRepository,
} from '../repositories/serviceEndpointRepository';
import type { EndpointStagePosteriorsRepository } from '../repositories/endpointStagePosteriorsRepository';
import type { CalibrationRepository } from '../repositories/calibrationRepository';
import type { TrustAssertionRepository } from '../repositories/trustAssertionRepository';
import {
  composeStagePosteriors,
  type ComposedPosterior,
} from './stagePosteriorComposition';
import { endpointHash } from '../utils/urlCanonical';

/** Kind NIP-33 addressable replaceable proposé pour les SatRank-compatible
 *  trust assertions. Range 30000-39999 = parameterized replaceable
 *  (NIP-01). 30782 a été choisi pour ne pas collisionner avec les kinds
 *  Nostr communs (30382-30384 SatRank endorsements existants). */
export const KIND_TRUST_ASSERTION = 30782;

/** TTL par défaut. valid_until = published_at + TRUST_ASSERTION_TTL_SEC.
 *  7 jours matche la cadence du publisher. Au-delà, un agent qui consomme
 *  l'event doit le considérer expired (verify_assertion MCP Phase 6.0
 *  flag "expired"). */
export const TRUST_ASSERTION_TTL_SEC = 7 * 86400;

/** Seuil meaningful — cohérent avec composition (Phase 5.14) et intent
 *  legacy (Phase 5.6). Un stage avec n_obs effectif < 3 est dominé par
 *  le prior, donc ne porte pas de signal informatif. */
const IS_MEANINGFUL_MIN_N_OBS = 3;

/** Skip window pour l'idempotence cron — un re-publish < 6 jours est
 *  superflu (les relays remplacent quand même via NIP-33, mais ça
 *  consomme de la bande). */
const SKIP_RECENTLY_PUBLISHED_SEC = 6 * 86400;

/** Cap par cycle cron pour éviter de saturer les relays sur un catalogue
 *  > 1000 endpoints. Default 200 = ~30 minutes par cycle à 6 publish/sec
 *  + une protection naturelle contre les bursts. */
const DEFAULT_MAX_PER_CYCLE = 200;

export interface TrustAssertionPublishResult {
  endpoint_url: string;
  event_id: string | null;
  outcome: 'published' | 'skipped_recent' | 'skipped_no_meaningful' | 'publish_failed';
  detail?: string;
}

export interface TrustAssertionCycleSummary {
  results: TrustAssertionPublishResult[];
  outcomes: Record<TrustAssertionPublishResult['outcome'], number>;
  cycle_started_at: number;
  cycle_finished_at: number;
}

export interface TrustAssertionPublisherDeps {
  serviceEndpointRepo: ServiceEndpointRepository;
  stagePosteriorsRepo: EndpointStagePosteriorsRepository;
  calibrationRepo: CalibrationRepository;
  trustAssertionRepo: TrustAssertionRepository;
  publisher: NostrMultiKindPublisher;
  oraclePubkey: string;
  /** Liste des relays auxquels on publie. Conservé dans la row pour
   *  /api/oracle/assertion. */
  relays: string[];
  now?: () => number;
}

export class TrustAssertionPublisher {
  private readonly now: () => number;

  constructor(private readonly deps: TrustAssertionPublisherDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Cycle cron : itère sur les endpoints actifs, publie kind 30782 quand
   *  applicable, persiste audit local. Caller (cron) gère la planification. */
  async publishCycle(opts: { maxPerCycle?: number } = {}): Promise<TrustAssertionCycleSummary> {
    const startedAt = this.now();
    const summary: TrustAssertionCycleSummary = {
      results: [],
      outcomes: {
        published: 0,
        skipped_recent: 0,
        skipped_no_meaningful: 0,
        publish_failed: 0,
      },
      cycle_started_at: startedAt,
      cycle_finished_at: 0,
    };

    // Un seul appel pour fetch la dernière calibration — cohérent pour
    // tous les endpoints du cycle.
    const latestCalibration = await this.deps.calibrationRepo.findLatestRun();
    const calibrationProof = latestCalibration?.published_event_id ?? null;

    const endpoints = await this.deps.serviceEndpointRepo.listActiveTrustedEndpoints(
      opts.maxPerCycle ?? DEFAULT_MAX_PER_CYCLE,
    );

    for (const endpoint of endpoints) {
      const result = await this.publishOne(endpoint, calibrationProof);
      summary.results.push(result);
      summary.outcomes[result.outcome] += 1;
    }

    summary.cycle_finished_at = this.now();
    return summary;
  }

  /** Publish (ou skip) un endpoint. Pure unit pour le test isolé. */
  async publishOne(
    endpoint: ServiceEndpoint,
    calibrationProof: string | null,
  ): Promise<TrustAssertionPublishResult> {
    const urlHash = endpointHash(endpoint.url);
    const nowSec = this.now();

    // Skip si publié récemment.
    const recent = await this.deps.trustAssertionRepo.wasPublishedRecently(
      urlHash,
      nowSec,
      SKIP_RECENTLY_PUBLISHED_SEC,
    );
    if (recent) {
      return { endpoint_url: endpoint.url, event_id: null, outcome: 'skipped_recent' };
    }

    // Lire les 5 stages, composer, filtrer.
    const stages = await this.deps.stagePosteriorsRepo.findAllStages(endpoint.url, nowSec);
    if (stages.size === 0) {
      return {
        endpoint_url: endpoint.url,
        event_id: null,
        outcome: 'skipped_no_meaningful',
        detail: 'no stage data',
      };
    }
    const composed = composeStagePosteriors(stages);
    const meaningfulCount = composed.meaningful_stages.length;
    if (meaningfulCount === 0) {
      return {
        endpoint_url: endpoint.url,
        event_id: null,
        outcome: 'skipped_no_meaningful',
        detail: `measured=${composed.measured_stages} but none >= n_obs ${IS_MEANINGFUL_MIN_N_OBS}`,
      };
    }

    // Build template + publish.
    const template = buildTrustAssertionTemplate(
      endpoint,
      urlHash,
      composed,
      this.deps.oraclePubkey,
      calibrationProof,
      nowSec,
    );
    let eventId: string | null = null;
    try {
      const publishResult = await this.deps.publisher.publishTemplate(template);
      eventId = publishResult.eventId;
      if (!publishResult.anySuccess) {
        return {
          endpoint_url: endpoint.url,
          event_id: eventId,
          outcome: 'publish_failed',
          detail: 'no relay accepted',
        };
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error(
        { url: endpoint.url, error: detail },
        'TrustAssertionPublisher: publish failed (event not persisted)',
      );
      return {
        endpoint_url: endpoint.url,
        event_id: null,
        outcome: 'publish_failed',
        detail,
      };
    }

    // Persist audit local après succès relais.
    try {
      await this.deps.trustAssertionRepo.upsert({
        endpoint_url_hash: urlHash,
        event_id: eventId,
        oracle_pubkey: this.deps.oraclePubkey,
        valid_until: nowSec + TRUST_ASSERTION_TTL_SEC,
        p_e2e: composed.p_e2e,
        meaningful_stages_count: meaningfulCount,
        calibration_proof_event_id: calibrationProof,
        published_at: nowSec,
        relays: this.deps.relays,
      });
    } catch (err) {
      // Erreur DB n'invalide pas la publication Nostr (déjà sortie).
      logger.warn(
        { url: endpoint.url, eventId, error: err instanceof Error ? err.message : String(err) },
        'TrustAssertionPublisher: audit persist failed (event was published to relays)',
      );
    }

    return {
      endpoint_url: endpoint.url,
      event_id: eventId,
      outcome: 'published',
    };
  }
}

/** Pure builder, testable en isolation. */
export function buildTrustAssertionTemplate(
  endpoint: ServiceEndpoint,
  urlHash: string,
  composed: ComposedPosterior,
  oraclePubkey: string,
  calibrationProof: string | null,
  createdAt: number,
): { kind: number; created_at: number; tags: string[][]; content: string } {
  const validUntil = createdAt + TRUST_ASSERTION_TTL_SEC;
  const fmt = (x: number | null) => (x == null ? 'null' : x.toFixed(4));
  const tags: string[][] = [
    ['d', urlHash], // NIP-33 addressable replaceable identifier
    ['endpoint_url', endpoint.url],
    ['valid_until', String(validUntil)],
    ['p_e2e', fmt(composed.p_e2e)],
    ['p_e2e_pessimistic', fmt(composed.p_e2e_pessimistic)],
    ['p_e2e_optimistic', fmt(composed.p_e2e_optimistic)],
    ['meaningful_stages_count', String(composed.meaningful_stages.length)],
    ['measured_stages', String(composed.measured_stages)],
    ['oracle_pubkey', oraclePubkey],
    ['http_method', endpoint.http_method],
  ];
  if (endpoint.service_price_sats != null) {
    tags.push(['price_sats', String(endpoint.service_price_sats)]);
  }
  if (calibrationProof) {
    // Permet à un agent de chaîner trust → calibration history :
    //   1. read kind 30782 (this assertion)
    //   2. follow calibration_proof tag → kind 30783 event
    //   3. read calibration delta_mean / delta_p95
    //   4. weighed trust = p_e2e × (1 - delta_mean) → effective probability
    tags.push(['calibration_proof', calibrationProof]);
  }
  if (endpoint.category) tags.push(['category', endpoint.category]);

  // Content = JSON canonical pour faciliter le verify offline. L'agent
  // peut parse le content + recompute le hash + check signature → bypass
  // entierement le besoin d'aller chercher l'event sur les relais.
  const content = JSON.stringify({
    schema_version: 1,
    endpoint_url: endpoint.url,
    endpoint_url_hash: urlHash,
    valid_until: validUntil,
    p_e2e: composed.p_e2e,
    p_e2e_pessimistic: composed.p_e2e_pessimistic,
    p_e2e_optimistic: composed.p_e2e_optimistic,
    meaningful_stages: composed.meaningful_stages,
    measured_stages: composed.measured_stages,
    stages: composed.stages,
    http_method: endpoint.http_method,
    price_sats: endpoint.service_price_sats,
    category: endpoint.category,
    calibration_proof: calibrationProof,
  });

  return {
    kind: KIND_TRUST_ASSERTION,
    created_at: createdAt,
    tags,
    content,
  };
}
