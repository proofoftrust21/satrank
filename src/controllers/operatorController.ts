// Phase 7 — controller HTTP pour l'abstraction operator.
//
// POST /api/operator/register : self-déclaration d'un operator + revendication
// d'identités + d'ownerships, avec vérification cryptographique inline des
// preuves fournies.
//
// Modèle de trust :
//   - NIP-98 gate la requête (anti-spam) — n'importe quel npub peut publier un
//     event signé, le rate-limiter global coupe les abus de masse.
//   - Chaque identity/ownership est claim en status 'pending' (verified_at=NULL).
//   - Les preuves fournies sont vérifiées inline (LN signature, NIP-05 fetch,
//     DNS TXT). Une preuve qui échoue ne bloque pas la requête — l'identity
//     est tout de même claim, juste non-verified. Ça permet au claimant
//     d'itérer sur un bug de config sans repartir de zéro.
//   - Le status operator ne passe 'verified' que si ≥2/3 preuves convergent
//     (règle dure appliquée par operatorService.recomputeStatus, appelé par
//     markIdentityVerified).
//
// Anti-abuse : un attaquant peut créer des operator_id fantômes (valides par
// NIP-98 mais sans preuve) — ils resteront 'pending' et ne contribuent pas au
// scoring. Le coût de stockage est plafonné par le rate-limit global.
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError, NotFoundError } from '../errors';
import { formatZodError } from '../utils/zodError';
import { logger } from '../logger';
import { verifyNip98 } from '../middleware/nip98';
import type { OperatorService } from '../services/operatorService';
import type { OperatorRepository, OperatorStatus } from '../repositories/operatorRepository';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { AgentRepository } from '../repositories/agentRepository';
import {
  verifyLnPubkeyOwnership,
  verifyNip05Ownership,
  verifyDnsOwnership,
  type NostrJsonFetcher,
  type DnsTxtResolver,
} from '../services/operatorVerificationService';

// operator_id opaque : tolère le format hex sha256 (64 chars, hérité de v31
// transactions.operator_id) et tout identifiant libre compatible.
const operatorIdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'operator_id must match [A-Za-z0-9._:-]');

const identitySchema = z.object({
  type: z.enum(['ln_pubkey', 'nip05', 'dns']),
  value: z.string().min(1).max(256),
  /** ECDSA sig hex (compact 64-byte = 128 hex chars) — requis pour type=ln_pubkey. */
  signature_hex: z.string().regex(/^[0-9a-fA-F]+$/).min(128).max(144).optional(),
  /** Pubkey Nostr attendu — requis pour type=nip05 (sinon le fetch ne peut pas décider). */
  expected_pubkey: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
});

const ownershipSchema = z.object({
  type: z.enum(['node', 'endpoint', 'service']),
  id: z.string().min(1).max(256),
});

const registerSchema = z.object({
  operator_id: operatorIdSchema,
  identities: z.array(identitySchema).max(10).default([]),
  ownerships: z.array(ownershipSchema).max(50).default([]),
});

export interface VerificationReport {
  type: 'ln_pubkey' | 'nip05' | 'dns';
  value: string;
  valid: boolean;
  /** Détail de l'échec (e.g. 'bad_signature', 'pubkey_mismatch'). Exposé au
   *  claimant car il est lui-même l'input (pas d'oracle possible). */
  reason?: string;
}

/** Options d'injection pour les tests (fetcher NIP-05 + resolver DNS). */
export interface OperatorControllerDeps {
  operatorService: OperatorService;
  /** Requis pour le handler list (count + findAll). Optionnel pour register/show. */
  operatorRepo?: OperatorRepository;
  nostrJsonFetcher?: NostrJsonFetcher;
  dnsTxtResolver?: DnsTxtResolver;
  /** Optionnel — quand fournis, enrichit le catalog avec les métadonnées
   *  endpoints (url, name, category) et nodes (alias, avg_score). */
  serviceEndpointRepo?: ServiceEndpointRepository;
  agentRepo?: AgentRepository;
}

const operatorIdParamSchema = z.object({
  id: operatorIdSchema,
});

const listQuerySchema = z.object({
  status: z.enum(['verified', 'pending', 'rejected']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export class OperatorController {
  private readonly operatorService: OperatorService;
  private readonly operatorRepo?: OperatorRepository;
  private readonly nostrJsonFetcher?: NostrJsonFetcher;
  private readonly dnsTxtResolver?: DnsTxtResolver;
  private readonly serviceEndpointRepo?: ServiceEndpointRepository;
  private readonly agentRepo?: AgentRepository;

  constructor(deps: OperatorControllerDeps) {
    this.operatorService = deps.operatorService;
    this.operatorRepo = deps.operatorRepo;
    this.nostrJsonFetcher = deps.nostrJsonFetcher;
    this.dnsTxtResolver = deps.dnsTxtResolver;
    this.serviceEndpointRepo = deps.serviceEndpointRepo;
    this.agentRepo = deps.agentRepo;
  }

  register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // --- NIP-98 authentication gate ---
      // fullUrl doit matcher exactement le tag `u` de l'event. On inclut
      // le path + query (originalUrl) pour que les GET paramétrés restent
      // signables ; express.req.originalUrl préserve la query string.
      const fullUrl = `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`;
      const authHeader = req.headers.authorization;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? null;
      const nip98 = await verifyNip98(authHeader, 'POST', fullUrl, rawBody);
      if (!nip98.valid) {
        // Détail en log serveur uniquement (audit M2) ; public reason collapse.
        logger.warn({ detail: nip98.detail, pubkey: nip98.pubkey }, 'NIP-98 rejected on /api/operator/register');
        res.status(401).json({
          error: { code: 'NIP98_INVALID', message: 'NIP-98 Authorization required and must be valid' },
        });
        return;
      }

      // --- Body parsing ---
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(formatZodError(parsed.error, req.body));
      const { operator_id: operatorId, identities, ownerships } = parsed.data;

      const now = Math.floor(Date.now() / 1000);

      // --- Create operator (pending) ---
      this.operatorService.upsertOperator(operatorId, now);

      // --- Claim + verify identities ---
      const verifications: VerificationReport[] = [];
      for (const identity of identities) {
        // Claim d'abord — l'identity apparaît même si la verify échoue.
        this.operatorService.claimIdentity(operatorId, identity.type, identity.value);

        const report = await this.verifyIdentity(operatorId, identity);
        verifications.push(report);
        if (report.valid) {
          this.operatorService.markIdentityVerified(
            operatorId,
            identity.type,
            identity.value,
            this.buildProofBlob(identity, report),
            now,
          );
        }
      }

      // --- Claim ownerships (pending — verify_at reste NULL) ---
      for (const ownership of ownerships) {
        this.operatorService.claimOwnership(operatorId, ownership.type, ownership.id, now);
      }

      // --- Final response ---
      const catalog = this.operatorService.getOperatorCatalog(operatorId, now);
      res.status(201).json({
        data: {
          operator_id: operatorId,
          status: catalog?.operator.status ?? 'pending',
          verification_score: catalog?.operator.verification_score ?? 0,
          verifications,
          catalog,
          nip98_pubkey: nip98.pubkey,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  private async verifyIdentity(
    operatorId: string,
    identity: z.infer<typeof identitySchema>,
  ): Promise<VerificationReport> {
    if (identity.type === 'ln_pubkey') {
      if (!identity.signature_hex) {
        return { type: 'ln_pubkey', value: identity.value, valid: false, reason: 'signature_missing' };
      }
      const res = verifyLnPubkeyOwnership(identity.value, operatorId, identity.signature_hex);
      return { type: 'ln_pubkey', value: identity.value, valid: res.valid, reason: res.detail };
    }
    if (identity.type === 'nip05') {
      if (!identity.expected_pubkey) {
        return { type: 'nip05', value: identity.value, valid: false, reason: 'expected_pubkey_missing' };
      }
      const res = await verifyNip05Ownership(
        identity.value,
        identity.expected_pubkey,
        this.nostrJsonFetcher,
      );
      return { type: 'nip05', value: identity.value, valid: res.valid, reason: res.detail };
    }
    // dns : pas de preuve inline, le TXT record est fetched live
    const res = await verifyDnsOwnership(identity.value, operatorId, this.dnsTxtResolver);
    return { type: 'dns', value: identity.value, valid: res.valid, reason: res.detail };
  }

  /** Encode la preuve persistée dans operator_identities.verification_proof.
   *  Signature hex pour LN, pubkey attendu pour NIP-05, empreinte du TXT pour DNS. */
  private buildProofBlob(
    identity: z.infer<typeof identitySchema>,
    _report: VerificationReport,
  ): string {
    if (identity.type === 'ln_pubkey') return `ecdsa:${identity.signature_hex ?? ''}`;
    if (identity.type === 'nip05') return `nip05:${identity.expected_pubkey ?? ''}`;
    return `dns:satrank-operator=${identity.value}`;
  }

  /** GET /api/operator/:id — catalog complet + agrégat Bayesian.
   *
   *  Distinction clé (cf. Précision 2 du checkpoint 1) :
   *    - catalog.nodes/endpoints/services = TOUTES les ressources claimed,
   *      même celles sans observation. L'operator doit pouvoir débugger son
   *      état ("je sais que j'ai 10 endpoints, pourquoi 3 n'ont pas d'obs ?").
   *    - bayesian.resources_counted = sous-ensemble qui contribue à l'agrégat
   *      (evidence > prior). Sert à auditer la masse d'évidence réelle.
   */
  show = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = operatorIdParamSchema.safeParse(req.params);
      if (!parsed.success) throw new ValidationError(formatZodError(parsed.error, req.params));
      const { id: operatorId } = parsed.data;

      const now = Math.floor(Date.now() / 1000);
      const catalog = this.operatorService.getOperatorCatalog(operatorId, now);
      if (catalog === null) throw new NotFoundError('operator', operatorId);

      const enrichedCatalog = this.enrichCatalog(catalog);

      res.json({
        data: {
          operator: {
            operator_id: catalog.operator.operator_id,
            status: catalog.operator.status,
            verification_score: catalog.operator.verification_score,
            first_seen: catalog.operator.first_seen,
            last_activity: catalog.operator.last_activity,
            created_at: catalog.operator.created_at,
          },
          identities: catalog.identities.map((i) => ({
            type: i.identity_type,
            value: i.identity_value,
            verified_at: i.verified_at,
            verification_proof: i.verification_proof,
          })),
          catalog: enrichedCatalog,
          bayesian: {
            posterior_alpha: catalog.aggregated.posteriorAlpha,
            posterior_beta: catalog.aggregated.posteriorBeta,
            p_success: Number.isFinite(catalog.aggregated.pSuccess) ? catalog.aggregated.pSuccess : null,
            n_obs_effective: catalog.aggregated.nObsEffective,
            resources_counted: catalog.aggregated.resourcesCounted,
            at_ts: catalog.aggregated.atTs,
          },
        },
        meta: { computedAt: now },
      });
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/operators — liste paginée filtrable par status.
   *
   *  Retourne les champs de base (operator_id, status, score, timestamps) —
   *  PAS de bayesian aggregate par-operator (trop cher en list-mode). Pour
   *  le détail complet, aller sur GET /:id.
   */
  list = (req: Request, res: Response, next: NextFunction): void => {
    try {
      if (!this.operatorRepo) {
        res.status(503).json({
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Operator listing not wired' },
        });
        return;
      }
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(formatZodError(parsed.error, req.query));
      const { status, limit, offset } = parsed.data;

      const rows = this.operatorRepo.findAll({ status, limit, offset });
      const total = this.operatorRepo.countFiltered(status);
      const counts = this.operatorRepo.countByStatus();

      res.json({
        data: rows.map((r) => ({
          operator_id: r.operator_id,
          status: r.status,
          verification_score: r.verification_score,
          first_seen: r.first_seen,
          last_activity: r.last_activity,
          created_at: r.created_at,
        })),
        meta: {
          total,
          limit,
          offset,
          counts: {
            verified: counts.verified,
            pending: counts.pending,
            rejected: counts.rejected,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  };

  /** Enrichit chaque ressource avec ses métadonnées (URL, alias, etc.). La
   *  liste complète des claims reste exposée — la jointure ajoute des champs,
   *  elle n'en filtre aucun (cf. Précision 2). */
  private enrichCatalog(
    catalog: ReturnType<OperatorService['getOperatorCatalog']> & object,
  ): {
    nodes: Array<{
      node_pubkey: string; claimed_at: number; verified_at: number | null;
      alias: string | null; avg_score: number | null;
    }>;
    endpoints: Array<{
      url_hash: string; claimed_at: number; verified_at: number | null;
      url: string | null; name: string | null; category: string | null; price_sats: number | null;
    }>;
    services: Array<{ service_hash: string; claimed_at: number; verified_at: number | null }>;
  } {
    const nodes = catalog.ownedNodes.map((n) => {
      const agent = this.agentRepo?.findByHash(n.node_pubkey);
      return {
        node_pubkey: n.node_pubkey,
        claimed_at: n.claimed_at,
        verified_at: n.verified_at,
        alias: agent?.alias ?? null,
        avg_score: agent?.avg_score ?? null,
      };
    });
    const endpoints = catalog.ownedEndpoints.map((e) => {
      const svc = this.serviceEndpointRepo?.findByUrlHash(e.url_hash);
      return {
        url_hash: e.url_hash,
        claimed_at: e.claimed_at,
        verified_at: e.verified_at,
        url: svc?.url ?? null,
        name: svc?.name ?? null,
        category: svc?.category ?? null,
        price_sats: svc?.service_price_sats ?? null,
      };
    });
    return {
      nodes,
      endpoints,
      services: catalog.ownedServices,
    };
  }
}
