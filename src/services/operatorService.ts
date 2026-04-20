// Phase 7 — operatorService : logique métier autour des operators.
//
// Responsabilités :
//   1. Recomputer le status en appliquant la règle dure 2/3 preuves.
//   2. Orchestrer claims + verifications via les repositories.
//   3. Agréger les posteriors Bayesian des resources possédées.
//
// ================================================================
// ARCHITECTURE D'AGRÉGATION BAYESIAN (à valider au Checkpoint 1)
// ================================================================
//
// Problème : un operator groupe N nodes + M endpoints + K services. Chaque
// ressource a son propre (α, β) streaming décayé. Comment rendre un état
// Bayesian unifié pour l'operator ?
//
// Choix : **somme des pseudo-évidences** par-dessus les ressources owned.
//
//   α_op = Σ_i (α_i − α₀) + α₀
//   β_op = Σ_i (β_i − β₀) + β₀
//   p_success_op = α_op / (α_op + β_op)
//   n_obs_op     = (α_op + β_op) − (α₀ + β₀)
//
// Propriétés :
//   - Préserve la somme d'évidence : 10 endpoints avec 5 obs chacun
//     → operator avec 50 obs, ce qui réduit correctement l'IC95%.
//   - Préserve la moyenne : si toutes les ressources ont p=0.7, le composite
//     tend vers 0.7 (∞-évidence). Si elles divergent, la moyenne pondérée par
//     volume d'évidence domine.
//   - Forward-only : on ne lit que les posteriors streaming courants,
//     jamais de backfill d'observations antérieures au claim ownership.
//     Une ressource ownée il y a 1h mais observée depuis 30j contribue
//     toute son évidence streaming — c'est voulu (l'évidence passée de la
//     ressource est présumée attribuable à l'operator qui la revendique
//     aujourd'hui et qui passe ensuite la vérification 2/3).
//
// Alternatives considérées :
//   a) Moyenne directe — ne reflète pas la masse d'évidence ("pente" correcte
//      mais "hauteur" plate). Rejeté : masquerait l'avantage d'un operator
//      avec beaucoup d'évidence.
//   b) Ingestion fan-out à l'écriture (chaque obs incrémente
//      aussi operator_streaming_posteriors) — techniquement plus performant
//      en lecture mais impose un changement de tous les sites d'ingestion.
//      Reporté : C4 reste read-time, C10+ pourra migrer si justifié.
//   c) Pondération par recency / verified_at des ownerships — complexifie
//      sans justification Bayesian. Rejeté.
//
// Impact sur le scoring : l'agrégat operator_id sert uniquement au
// composite /api/operator/:id et au prior hiérarchique (C10 — poids 0.5×).
// Le verdict par-ressource reste la source de vérité pour /api/endpoint et
// /api/agent/:hash/verdict.
// ================================================================

import {
  OperatorRepository,
  OperatorIdentityRepository,
  OperatorOwnershipRepository,
  type IdentityType,
  type OperatorStatus,
  type OperatorRow,
  type OperatorIdentityRow,
} from '../repositories/operatorRepository';
import type {
  EndpointStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import { DEFAULT_PRIOR_ALPHA, DEFAULT_PRIOR_BETA } from '../config/bayesianConfig';
import { logger } from '../logger';
import { operatorClaimsTotal } from '../middleware/metrics';

/** Règle dure du brief : ≥2 identités vérifiées → status='verified'. */
const MIN_VERIFIED_IDENTITIES_FOR_VERIFIED = 2;

export interface OperatorCatalog {
  operator: OperatorRow;
  identities: OperatorIdentityRow[];
  ownedNodes: Array<{ node_pubkey: string; claimed_at: number; verified_at: number | null }>;
  ownedEndpoints: Array<{ url_hash: string; claimed_at: number; verified_at: number | null }>;
  ownedServices: Array<{ service_hash: string; claimed_at: number; verified_at: number | null }>;
  aggregated: OperatorBayesianAggregate;
}

export interface OperatorBayesianAggregate {
  /** α agrégé (somme des pseudo-évidences + prior flat). */
  posteriorAlpha: number;
  /** β agrégé (symétrique). */
  posteriorBeta: number;
  /** p_success bayésien agrégé. NaN si aucune évidence (α=α₀, β=β₀). */
  pSuccess: number;
  /** n_obs effectif = (α + β) − (α₀ + β₀). */
  nObsEffective: number;
  /** Nombre de ressources owned qui ont contribué de l'évidence non-triviale. */
  resourcesCounted: number;
  /** Timestamp de l'agrégation (= atTs passé à readAllSourcesDecayed). */
  atTs: number;
}

export class OperatorService {
  constructor(
    private readonly operators: OperatorRepository,
    private readonly identities: OperatorIdentityRepository,
    private readonly ownerships: OperatorOwnershipRepository,
    private readonly endpointPosteriors: EndpointStreamingPosteriorRepository,
    private readonly nodePosteriors: NodeStreamingPosteriorRepository,
    private readonly servicePosteriors: ServiceStreamingPosteriorRepository,
  ) {}

  /** Crée un operator pending. Idempotent. */
  upsertOperator(operatorId: string, now: number = Math.floor(Date.now() / 1000)): void {
    this.operators.upsertPending(operatorId, now);
  }

  claimIdentity(operatorId: string, type: IdentityType, value: string): void {
    this.operators.touch(operatorId);
    this.identities.claim(operatorId, type, value);
    logger.info({ operatorId, type, value }, 'operator identity claimed');
  }

  /** Marque l'identité comme vérifiée + recompute le status global. */
  markIdentityVerified(
    operatorId: string,
    type: IdentityType,
    value: string,
    proof: string,
    now: number = Math.floor(Date.now() / 1000),
  ): OperatorStatus {
    this.identities.markVerified(operatorId, type, value, proof, now);
    this.operators.touch(operatorId, now);
    const status = this.recomputeStatus(operatorId);
    logger.info(
      { operatorId, type, value, status, at: now },
      'operator identity verified',
    );
    return status;
  }

  /** Règle dure : count(verified identities) ≥ 2 → 'verified'. Score = count
   *  brut (0..3). Le status 'rejected' reste décisoire (uniquement via API
   *  admin — jamais auto-atteint ici). */
  recomputeStatus(operatorId: string): OperatorStatus {
    const rows = this.identities.findByOperator(operatorId);
    const verifiedCount = rows.filter((r) => r.verified_at !== null).length;
    const current = this.operators.findById(operatorId);
    if (current === null) {
      throw new Error(`operator ${operatorId} not found`);
    }
    // On ne descend pas 'verified' → 'pending' automatiquement : un operator
    // qui a atteint 2/3 reste verified même si une preuve est retirée (le
    // retour en pending est explicit via endpoint admin). Rejected reste gelé.
    if (current.status === 'rejected') return 'rejected';
    const nextStatus: OperatorStatus =
      verifiedCount >= MIN_VERIFIED_IDENTITIES_FOR_VERIFIED ? 'verified' : current.status;
    this.operators.updateVerification(operatorId, verifiedCount, nextStatus);
    return nextStatus;
  }

  claimOwnership(
    operatorId: string,
    resourceType: 'node' | 'endpoint' | 'service',
    resourceId: string,
    now: number = Math.floor(Date.now() / 1000),
  ): void {
    this.operators.touch(operatorId, now);
    if (resourceType === 'node') this.ownerships.claimNode(operatorId, resourceId, now);
    else if (resourceType === 'endpoint') this.ownerships.claimEndpoint(operatorId, resourceId, now);
    else this.ownerships.claimService(operatorId, resourceId, now);
    operatorClaimsTotal.inc({ resource_type: resourceType });
    logger.info(
      { operatorId, resourceType, resourceId, at: now },
      'operator ownership claimed',
    );
  }

  verifyOwnership(
    operatorId: string,
    resourceType: 'node' | 'endpoint' | 'service',
    resourceId: string,
    now: number = Math.floor(Date.now() / 1000),
  ): void {
    if (resourceType === 'node') this.ownerships.verifyNode(operatorId, resourceId, now);
    else if (resourceType === 'endpoint') this.ownerships.verifyEndpoint(operatorId, resourceId, now);
    else this.ownerships.verifyService(operatorId, resourceId, now);
  }

  /** Agrège les posteriors Bayesian par somme des pseudo-évidences. Voir
   *  le gros bloc d'architecture en tête de fichier. */
  aggregateBayesianForOperator(
    operatorId: string,
    atTs: number = Math.floor(Date.now() / 1000),
  ): OperatorBayesianAggregate {
    const nodes = this.ownerships.listNodes(operatorId);
    const endpoints = this.ownerships.listEndpoints(operatorId);
    const services = this.ownerships.listServices(operatorId);

    let excessAlpha = 0;
    let excessBeta = 0;
    let resourcesCounted = 0;

    const accumulate = (alpha: number, beta: number): void => {
      const eA = alpha - DEFAULT_PRIOR_ALPHA;
      const eB = beta - DEFAULT_PRIOR_BETA;
      if (eA > 0 || eB > 0) {
        excessAlpha += eA;
        excessBeta += eB;
        resourcesCounted += 1;
      }
    };

    for (const n of nodes) {
      const ps = this.nodePosteriors.readAllSourcesDecayed(n.node_pubkey, atTs);
      // On agrège sur les 3 sources (probe + report + paid) — cohérent avec
      // ce que fait le verdict par-ressource.
      const a = ps.probe.posteriorAlpha + ps.report.posteriorAlpha + ps.paid.posteriorAlpha
        - 2 * DEFAULT_PRIOR_ALPHA; // soustraire 2 priors redondants (on en garde 1)
      const b = ps.probe.posteriorBeta + ps.report.posteriorBeta + ps.paid.posteriorBeta
        - 2 * DEFAULT_PRIOR_BETA;
      accumulate(a, b);
    }
    for (const e of endpoints) {
      const ps = this.endpointPosteriors.readAllSourcesDecayed(e.url_hash, atTs);
      const a = ps.probe.posteriorAlpha + ps.report.posteriorAlpha + ps.paid.posteriorAlpha
        - 2 * DEFAULT_PRIOR_ALPHA;
      const b = ps.probe.posteriorBeta + ps.report.posteriorBeta + ps.paid.posteriorBeta
        - 2 * DEFAULT_PRIOR_BETA;
      accumulate(a, b);
    }
    for (const s of services) {
      const ps = this.servicePosteriors.readAllSourcesDecayed(s.service_hash, atTs);
      const a = ps.probe.posteriorAlpha + ps.report.posteriorAlpha + ps.paid.posteriorAlpha
        - 2 * DEFAULT_PRIOR_ALPHA;
      const b = ps.probe.posteriorBeta + ps.report.posteriorBeta + ps.paid.posteriorBeta
        - 2 * DEFAULT_PRIOR_BETA;
      accumulate(a, b);
    }

    const posteriorAlpha = DEFAULT_PRIOR_ALPHA + excessAlpha;
    const posteriorBeta = DEFAULT_PRIOR_BETA + excessBeta;
    const total = posteriorAlpha + posteriorBeta;
    const priorTotal = DEFAULT_PRIOR_ALPHA + DEFAULT_PRIOR_BETA;
    const nObsEffective = total - priorTotal;
    const pSuccess = nObsEffective > 0 ? posteriorAlpha / total : NaN;

    return {
      posteriorAlpha,
      posteriorBeta,
      pSuccess,
      nObsEffective,
      resourcesCounted,
      atTs,
    };
  }

  getOperatorCatalog(
    operatorId: string,
    atTs: number = Math.floor(Date.now() / 1000),
  ): OperatorCatalog | null {
    const op = this.operators.findById(operatorId);
    if (op === null) return null;
    return {
      operator: op,
      identities: this.identities.findByOperator(operatorId),
      ownedNodes: this.ownerships.listNodes(operatorId),
      ownedEndpoints: this.ownerships.listEndpoints(operatorId),
      ownedServices: this.ownerships.listServices(operatorId),
      aggregated: this.aggregateBayesianForOperator(operatorId, atTs),
    };
  }

  /** Resolve { operator_id, status } for a node pubkey. null si le node n'est
   *  claim par aucun operator. Utilisé par /api/agent/:hash/verdict pour :
   *    1. exposer operator_id (C11, uniquement si status='verified')
   *    2. emit advisory OPERATOR_UNVERIFIED (C12, si status ≠ 'verified'). */
  resolveOperatorForNode(nodePubkey: string): OperatorResourceLookup | null {
    const ownership = this.ownerships.findOperatorForNode(nodePubkey);
    if (!ownership) return null;
    const op = this.operators.findById(ownership.operator_id);
    if (!op) return null;
    return { operatorId: op.operator_id, status: op.status };
  }

  /** Symmetric de resolveOperatorForNode, indexé par url_hash (endpoint). */
  resolveOperatorForEndpoint(urlHash: string): OperatorResourceLookup | null {
    const ownership = this.ownerships.findOperatorForEndpoint(urlHash);
    if (!ownership) return null;
    const op = this.operators.findById(ownership.operator_id);
    if (!op) return null;
    return { operatorId: op.operator_id, status: op.status };
  }
}

export interface OperatorResourceLookup {
  operatorId: string;
  status: OperatorStatus;
}
