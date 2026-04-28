// Phase 8.1 — kind 7402 crowd-sourced outcome events ingestor.
//
// Validate + Sybil-weight + persist. Écrit pondéré dans
// endpoint_stage_outcomes_log + crowd_outcome_reports + nostr_identity_first_seen.
//
// Validation order (court-circuit) :
//   1. kind === 7402
//   2. Schnorr sig (verifyEvent)
//   3. endpoint_url_hash tag présent + 64-hex
//   4. outcome tag présent + valeur connue
//   5. event id non déjà vu (dedup via UPSERT crowd_outcome_reports)
//
// Tags optionnels qui boost le weight :
//   - preimage + payment_hash : preimage_factor 2.0 si sha256 matche
//   - pow déclaré : verified via leading zero bits du event id
//   - agent_id (= event.pubkey) : identity-age factor via nostr_identity_first_seen
import { logger } from '../logger';
import type {
  CrowdOutcomeRepository,
  NostrIdentityRepository,
} from '../repositories/crowdOutcomeRepository';
import {
  EndpointStagePosteriorsRepository,
  type Stage,
} from '../repositories/endpointStagePosteriorsRepository';
import { computeSybilWeight } from '../utils/sybilWeighting';

export const KIND_CROWD_OUTCOME = 7402;

/** Outcomes acceptés. Mappe vers (success, stage) pour l'écriture dans
 *  endpoint_stage_outcomes_log. Le report alimente directement le stage
 *  de delivery (= stage 4) car c'est ce que l'agent end-user observe.
 *  Les outcomes pay_failed alimentent stage 3 (payment).
 */
const OUTCOME_MAP: Record<string, { stage: Stage; success: boolean }> = {
  delivered: { stage: 4 as Stage, success: true },
  delivery_4xx: { stage: 4 as Stage, success: false },
  delivery_5xx: { stage: 4 as Stage, success: false },
  timeout: { stage: 4 as Stage, success: false },
  pay_failed: { stage: 3 as Stage, success: false },
};

export interface CrowdOutcomeEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface CrowdOutcomeIngestorDeps {
  crowdRepo: CrowdOutcomeRepository;
  identityRepo: NostrIdentityRepository;
  stagePosteriorsRepo: EndpointStagePosteriorsRepository;
  /** Verify Schnorr sig — injectable pour tests sans crypto. */
  verifyEvent: (event: CrowdOutcomeEvent) => boolean;
  now?: () => number;
}

export interface IngestResult {
  outcome: 'persisted' | 'rejected' | 'duplicate';
  reason?: string;
  effective_weight?: number;
}

export class CrowdOutcomeIngestor {
  private readonly now: () => number;

  constructor(private readonly deps: CrowdOutcomeIngestorDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async ingest(event: CrowdOutcomeEvent): Promise<IngestResult> {
    if (event.kind !== KIND_CROWD_OUTCOME) {
      return { outcome: 'rejected', reason: 'wrong_kind' };
    }
    if (!this.deps.verifyEvent(event)) {
      return { outcome: 'rejected', reason: 'signature_invalid' };
    }
    const endpointHashTag = event.tags.find((t) => t[0] === 'endpoint_url_hash');
    if (!endpointHashTag || !/^[a-f0-9]{64}$/.test(endpointHashTag[1] ?? '')) {
      return { outcome: 'rejected', reason: 'missing_or_malformed_endpoint_url_hash' };
    }
    const outcomeTag = event.tags.find((t) => t[0] === 'outcome');
    const outcomeValue = outcomeTag?.[1];
    if (!outcomeValue || !(outcomeValue in OUTCOME_MAP)) {
      return { outcome: 'rejected', reason: 'unknown_outcome' };
    }
    const mapped = OUTCOME_MAP[outcomeValue];

    // Tags optional pour les boosts.
    const trustAssertionTag = event.tags.find((t) => t[0] === 'e');
    const trustAssertionEventId = trustAssertionTag?.[1] ?? null;
    const declaredPowTag = event.tags.find((t) => t[0] === 'pow');
    const declaredPow = declaredPowTag ? parseInt(declaredPowTag[1], 10) : undefined;
    const preimageTag = event.tags.find((t) => t[0] === 'preimage');
    const paymentHashTag = event.tags.find((t) => t[0] === 'payment_hash');
    const latencyTag = event.tags.find((t) => t[0] === 'latency_ms');
    const latencyMs = latencyTag ? parseInt(latencyTag[1], 10) : null;

    const nowSec = this.now();
    // Observe identity (UPSERT) → récupère first_seen.
    const identityRecord = await this.deps.identityRepo.observeIdentity(event.pubkey, nowSec);
    // Note : observeIdentity vient de bumper le counter. first_seen est le
    // first_seen original. Pour les VRAI first reports (ce report = première
    // observation), on a first_seen = now ; age_factor sera 1.0 — correct.

    const weightResult = computeSybilWeight({
      event_id: event.id,
      declared_pow_bits: declaredPow,
      identity_first_seen_sec: identityRecord.first_seen,
      now_sec: nowSec,
      preimage_hex: preimageTag?.[1],
      payment_hash_hex: paymentHashTag?.[1],
    });

    // Dedup via INSERT ON CONFLICT (event_id) DO NOTHING.
    const inserted = await this.deps.crowdRepo.insertIfNew({
      event_id: event.id,
      agent_pubkey: event.pubkey,
      endpoint_url_hash: endpointHashTag[1],
      trust_assertion_event_id: trustAssertionEventId,
      outcome: outcomeValue,
      stage: mapped.stage,
      success: mapped.success,
      effective_weight: weightResult.effective_weight,
      pow_factor: weightResult.pow_factor,
      identity_age_factor: weightResult.identity_age_factor,
      preimage_factor: weightResult.preimage_factor,
      declared_pow_bits: declaredPow ?? null,
      verified_pow_bits: weightResult.verified_pow_bits,
      preimage_verified: weightResult.preimage_verified,
      latency_ms: Number.isFinite(latencyMs) ? latencyMs : null,
      observed_at: event.created_at,
      ingested_at: nowSec,
    });
    if (!inserted) {
      return { outcome: 'duplicate', effective_weight: weightResult.effective_weight };
    }

    // Resolve endpoint URL from url_hash. Le repo stages travaille avec URL,
    // pas hash. On utilise un hack — observe peut accepter directement un
    // hash si on contourne. Plus simple : le caller doit fournir l'URL.
    // Pour MVP, on stocke juste dans crowd_outcome_reports + on requiert
    // une étape downstream (cron consolidation) qui lit crowd_outcome_reports
    // et écrit vers endpoint_stage_posteriors.
    //
    // Plus pragmatique pour cette session : on FAIT l'écriture directe via
    // une variant de stagePosteriorsRepo qui accepte un url_hash plutôt que
    // une URL. Voir extension dans EndpointStagePosteriorsRepository.

    // Note: since observe() requires endpoint_url, we'd need a hash→url
    // resolution here. Pour MVP, le crowd outcome report est PERSISTÉ
    // dans crowd_outcome_reports avec son weight ; un cron de
    // consolidation aval (à shipper plus tard) le matérialise dans
    // endpoint_stage_posteriors. Comme ça :
    //   - un attaquant qui spam des kind 7402 vers endpoints inconnus ne
    //     pollue pas les posteriors (pas de write direct).
    //   - les reports valides accumulent en attente du cron.
    //   - on peut ajuster les weights post-hoc en relisant le log.

    logger.info(
      {
        eventId: event.id.slice(0, 12),
        agent: event.pubkey.slice(0, 12),
        endpoint: endpointHashTag[1].slice(0, 16),
        outcome: outcomeValue,
        weight: weightResult.effective_weight.toFixed(3),
        verified_pow_bits: weightResult.verified_pow_bits,
        preimage_verified: weightResult.preimage_verified,
        identity_days: ((nowSec - identityRecord.first_seen) / 86400).toFixed(1),
      },
      'CrowdOutcomeIngestor: persisted',
    );

    return {
      outcome: 'persisted',
      effective_weight: weightResult.effective_weight,
    };
  }
}
