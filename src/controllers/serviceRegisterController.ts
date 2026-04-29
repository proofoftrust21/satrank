// Excellence pass — NIP-98-gated self-registration with operator linkage and
// audit trail. The controller exposes 3 verbs against /api/services/register:
//
//   POST   register   — submit a new URL; first signer claims ownership
//   PATCH  update     — update metadata; only the original signer (operator_id)
//   DELETE deprecate  — soft-delete; only the original signer
//
// All three require a valid NIP-98 Authorization header. The signed event id +
// signer npub are recorded to `service_register_log` for forensics. The first
// successful POST against a given URL claims ownership via `operator_id` on
// `service_endpoints` plus the operator_owns_endpoint relation; subsequent
// modifications by a different npub return 409 Conflict.
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { RegistryCrawler } from '../crawler/registryCrawler';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { ServiceRegisterLogRepository, ServiceRegisterAction } from '../repositories/serviceRegisterLogRepository';
import type { OperatorService } from '../services/operatorService';
import { ValidationError } from '../errors';
import { formatZodError } from '../utils/zodError';
import { isValidCategoryFormat, normalizeCategory } from '../utils/categoryValidation';
import { verifyNip98 } from '../middleware/nip98';
import { endpointHash } from '../utils/urlCanonical';
import { logger } from '../logger';

const registerSchema = z.object({
  url: z.string().url().max(500),
  name: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  // Phase 5 — la catégorie est normalisée (trim/lower + alias) puis validée
  // contre le regex partagé. Rejet explicite en 400 INVALID_CATEGORY_FORMAT
  // plutôt qu'un skip silencieux : l'operator saura que sa valeur est refusée.
  category: z
    .string()
    .max(50)
    .optional()
    .transform(v => (v == null ? v : normalizeCategory(v) ?? v))
    .refine(v => v == null || isValidCategoryFormat(v), {
      message: 'category must match /^[a-z][a-z0-9/_-]{1,31}$/ (e.g. "weather-api", "data/finance")',
    }),
  provider: z.string().max(100).optional(),
});

const updateSchema = z.object({
  url: z.string().url().max(500),
  name: z.string().max(100).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  category: z
    .string()
    .max(50)
    .nullable()
    .optional()
    .transform(v => (v == null ? v : normalizeCategory(v) ?? v))
    .refine(v => v == null || isValidCategoryFormat(v), {
      message: 'category must match /^[a-z][a-z0-9/_-]{1,31}$/',
    }),
  provider: z.string().max(100).nullable().optional(),
});

const deleteSchema = z.object({
  url: z.string().url().max(500),
  reason: z.string().max(200).optional(),
});

export interface ServiceRegisterControllerDeps {
  registryCrawler: RegistryCrawler | null;
  serviceEndpointRepo: ServiceEndpointRepository;
  registerLogRepo: ServiceRegisterLogRepository;
  operatorService: OperatorService;
}

export class ServiceRegisterController {
  private readonly registryCrawler: RegistryCrawler | null;
  private readonly serviceEndpointRepo: ServiceEndpointRepository;
  private readonly registerLogRepo: ServiceRegisterLogRepository;
  private readonly operatorService: OperatorService;

  constructor(deps: ServiceRegisterControllerDeps) {
    this.registryCrawler = deps.registryCrawler;
    this.serviceEndpointRepo = deps.serviceEndpointRepo;
    this.registerLogRepo = deps.registerLogRepo;
    this.operatorService = deps.operatorService;
  }

  /** Build the absolute URL the NIP-98 client should have signed. We use
   *  originalUrl (path + query) so query-string-bearing variants stay signable. */
  private fullUrl(req: Request): string {
    return `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`;
  }

  /** Verify NIP-98 and return the signer pubkey + event id, or send a 401. */
  private async authenticate(req: Request, res: Response, method: 'POST' | 'PATCH' | 'DELETE'): Promise<{ npub: string; eventId: string } | null> {
    const authHeader = req.headers.authorization;
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? null;
    const result = await verifyNip98(authHeader, method, this.fullUrl(req), rawBody);
    if (!result.valid || !result.pubkey || !result.event_id) {
      logger.warn(
        { detail: result.detail, pubkey: result.pubkey, route: '/api/services/register', method },
        'NIP-98 rejected on /api/services/register',
      );
      res.status(401).json({
        error: { code: 'NIP98_INVALID', message: 'NIP-98 Authorization required and must be valid' },
      });
      return null;
    }
    return { npub: result.pubkey, eventId: result.event_id };
  }

  /** Persist an audit-log entry. Failures are logged but never propagate —
   *  the audit trail is best-effort and must not break the user-visible flow. */
  private async safeLog(args: {
    url: string;
    npub: string;
    eventId: string;
    action: ServiceRegisterAction;
    success: boolean;
    reason?: string | null;
    payload?: Record<string, unknown> | null;
  }): Promise<void> {
    try {
      await this.registerLogRepo.log({
        url: args.url,
        url_hash: endpointHash(args.url),
        npub_hex: args.npub,
        nip98_event_id: args.eventId,
        action: args.action,
        success: args.success,
        reason: args.reason ?? null,
        payload: args.payload ?? null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { error: msg, url: args.url, npub: args.npub, action: args.action },
        'service_register_log write failed (non-fatal)',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // POST /api/services/register — submit a new endpoint, claim ownership
  // ---------------------------------------------------------------------------
  register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!this.registryCrawler) {
        res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Self-registration unavailable — LND BOLT11 decoder not configured' } });
        return;
      }

      const auth = await this.authenticate(req, res, 'POST');
      if (!auth) return;

      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        await this.safeLog({
          url: typeof req.body?.url === 'string' ? req.body.url : 'unknown',
          npub: auth.npub,
          eventId: auth.eventId,
          action: 'register',
          success: false,
          reason: 'validation_failed',
          payload: req.body ?? null,
        });
        throw new ValidationError(formatZodError(parsed.error, req.body));
      }

      const { url, name, description, category, provider } = parsed.data;
      const urlHash = endpointHash(url);

      // 1. Auto-create operator (pending) before claiming anything against it.
      await this.operatorService.upsertOperator(auth.npub);

      // 2. First-claim guard — if the URL exists with a different operator_id,
      // refuse the claim. We do NOT call registerSelfSubmitted before this
      // check to avoid recording bogus probes for hostile re-claims.
      const existing = await this.serviceEndpointRepo.findByUrl(url);
      if (existing && existing.operator_id && existing.operator_id !== auth.npub) {
        await this.safeLog({
          url,
          npub: auth.npub,
          eventId: auth.eventId,
          action: 'register',
          success: false,
          reason: 'already_claimed_by_another_operator',
          payload: parsed.data,
        });
        res.status(409).json({
          error: {
            code: 'ALREADY_CLAIMED',
            message: 'This URL was registered by a different operator. Each L402 endpoint can only be claimed once.',
          },
        });
        return;
      }

      // 3. Validate the L402 endpoint via the existing crawler path. This
      // performs the SSRF-safe fetch, BOLT11 decode, agent_hash mapping and
      // metadata patch (no-overwrite policy).
      const result = await this.registryCrawler.registerSelfSubmitted(url, { name, description, category, provider });
      if (!result) {
        await this.safeLog({
          url,
          npub: auth.npub,
          eventId: auth.eventId,
          action: 'register',
          success: false,
          reason: 'not_l402',
          payload: parsed.data,
        });
        res.status(400).json({
          error: {
            code: 'NOT_L402',
            message: 'URL is not a valid L402 endpoint. Expected GET to return 402 with WWW-Authenticate header containing a BOLT11 invoice.',
          },
        });
        return;
      }

      // 4. Claim ownership: set operator_id only if NULL (idempotent re-submit
      // by the same operator is fine). claimEndpoint handles the operator_owns_endpoint
      // mirror with ON CONFLICT DO NOTHING.
      const claim = await this.serviceEndpointRepo.setOperatorIdIfNull(url, auth.npub);
      if (!claim.updated && claim.previousOperatorId && claim.previousOperatorId !== auth.npub) {
        // Race: someone else just claimed between findByUrl and setOperatorIdIfNull.
        await this.safeLog({
          url,
          npub: auth.npub,
          eventId: auth.eventId,
          action: 'register',
          success: false,
          reason: 'race_lost_to_another_operator',
          payload: parsed.data,
        });
        res.status(409).json({
          error: { code: 'ALREADY_CLAIMED', message: 'This URL was just claimed by a different operator.' },
        });
        return;
      }
      await this.operatorService.claimOwnership(auth.npub, 'endpoint', urlHash);

      await this.safeLog({
        url,
        npub: auth.npub,
        eventId: auth.eventId,
        action: 'register',
        success: true,
        payload: { fieldsUpdated: result.fieldsUpdated, priceSats: result.priceSats },
      });

      res.status(201).json({
        data: {
          url,
          url_hash: urlHash,
          registered: true,
          agentHash: result.agentHash,
          priceSats: result.priceSats,
          fieldsUpdated: result.fieldsUpdated,
          operator_id: auth.npub,
          message: result.fieldsUpdated.length === 0
            ? 'Service already has metadata from 402index — self-register fields ignored (no-overwrite policy).'
            : `Service registered. Fields added: ${result.fieldsUpdated.join(', ')}. Visible at GET /api/services within 30 minutes.`,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  // ---------------------------------------------------------------------------
  // PATCH /api/services/register — update metadata; owner-only
  // ---------------------------------------------------------------------------
  update = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const auth = await this.authenticate(req, res, 'PATCH');
      if (!auth) return;

      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        await this.safeLog({
          url: typeof req.body?.url === 'string' ? req.body.url : 'unknown',
          npub: auth.npub,
          eventId: auth.eventId,
          action: 'update',
          success: false,
          reason: 'validation_failed',
          payload: req.body ?? null,
        });
        throw new ValidationError(formatZodError(parsed.error, req.body));
      }

      const { url, name, description, category, provider } = parsed.data;
      const existing = await this.serviceEndpointRepo.findByUrl(url);
      if (!existing) {
        await this.safeLog({
          url, npub: auth.npub, eventId: auth.eventId, action: 'update', success: false, reason: 'not_found', payload: parsed.data,
        });
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No endpoint registered for this URL.' } });
        return;
      }
      if (existing.operator_id !== auth.npub) {
        await this.safeLog({
          url, npub: auth.npub, eventId: auth.eventId, action: 'update', success: false, reason: 'not_owner', payload: parsed.data,
        });
        res.status(403).json({
          error: { code: 'NOT_OWNER', message: 'Only the operator who registered this URL can update it.' },
        });
        return;
      }

      // PATCH semantics: undefined = leave alone, null = clear, string = set.
      const patch: { name?: string | null; description?: string | null; category?: string | null; provider?: string | null } = {};
      if (name !== undefined) patch.name = name === null ? null : name.trim() || null;
      if (description !== undefined) patch.description = description === null ? null : description.trim() || null;
      if (category !== undefined) patch.category = category === null ? null : category;
      if (provider !== undefined) patch.provider = provider === null ? null : provider.trim() || null;

      // Owner is allowed to overwrite (no-overwrite policy applies to anonymous
      // self-register only). Build the merged row by hand so unset fields stay
      // as they are.
      const merged = {
        name: 'name' in patch ? patch.name ?? null : existing.name ?? null,
        description: 'description' in patch ? patch.description ?? null : existing.description ?? null,
        category: 'category' in patch ? patch.category ?? null : existing.category ?? null,
        provider: 'provider' in patch ? patch.provider ?? null : existing.provider ?? null,
      };
      await this.serviceEndpointRepo.updateMetadata(url, merged);

      await this.safeLog({
        url, npub: auth.npub, eventId: auth.eventId, action: 'update', success: true, payload: patch,
      });

      res.status(200).json({ data: { url, url_hash: endpointHash(url), updated: true, fields: Object.keys(patch) } });
    } catch (err) {
      next(err);
    }
  };

  // ---------------------------------------------------------------------------
  // DELETE /api/services/register — soft-delete; owner-only
  // ---------------------------------------------------------------------------
  remove = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const auth = await this.authenticate(req, res, 'DELETE');
      if (!auth) return;

      const parsed = deleteSchema.safeParse(req.body);
      if (!parsed.success) {
        await this.safeLog({
          url: typeof req.body?.url === 'string' ? req.body.url : 'unknown',
          npub: auth.npub,
          eventId: auth.eventId,
          action: 'delete',
          success: false,
          reason: 'validation_failed',
          payload: req.body ?? null,
        });
        throw new ValidationError(formatZodError(parsed.error, req.body));
      }

      const { url, reason } = parsed.data;
      const existing = await this.serviceEndpointRepo.findByUrl(url);
      if (!existing) {
        await this.safeLog({
          url, npub: auth.npub, eventId: auth.eventId, action: 'delete', success: false, reason: 'not_found',
        });
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No endpoint registered for this URL.' } });
        return;
      }
      if (existing.operator_id !== auth.npub) {
        await this.safeLog({
          url, npub: auth.npub, eventId: auth.eventId, action: 'delete', success: false, reason: 'not_owner',
        });
        res.status(403).json({
          error: { code: 'NOT_OWNER', message: 'Only the operator who registered this URL can delete it.' },
        });
        return;
      }

      const trimmedReason = (reason ?? '').trim();
      const auditReason = trimmedReason.length > 0
        ? `operator_self_delete: ${trimmedReason}`
        : 'operator_self_delete';
      const updated = await this.serviceEndpointRepo.deprecateByUrl(url, auditReason);
      if (!updated) {
        await this.safeLog({
          url, npub: auth.npub, eventId: auth.eventId, action: 'delete', success: false, reason: 'already_deprecated',
        });
        res.status(409).json({
          error: { code: 'ALREADY_DEPRECATED', message: 'Endpoint is already deprecated.' },
        });
        return;
      }

      await this.safeLog({
        url, npub: auth.npub, eventId: auth.eventId, action: 'delete', success: true, payload: { reason: trimmedReason || null },
      });

      res.status(200).json({ data: { url, url_hash: endpointHash(url), deprecated: true } });
    } catch (err) {
      next(err);
    }
  };
}
