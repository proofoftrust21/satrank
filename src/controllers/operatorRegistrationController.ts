// Phase 10 (2026-05-04) — Operator-side SDK : POST /api/operator/register-endpoint
// + GET /api/operator/:pubkey/dashboard.
//
// Self-service endpoint registration. NIP-98 auth on POST ; the operator
// signs the registration payload with their Nostr key. Verification of
// the actual operator_pubkey ↔ domain binding is async (cron tick on
// OperatorEndpointRegistrationService.runVerificationCycle).
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { verifyNip98 } from '../middleware/nip98';
import { logger } from '../logger';
import {
  InvalidRegistrationError,
  type OperatorEndpointRegistrationService,
} from '../services/operatorEndpointRegistrationService';
import type { OperatorEndpointRegistrationRepository } from '../repositories/operatorEndpointRegistrationRepository';
import { InvalidDomainError } from '../services/operatorAttestationService';

const PUBKEY_RE = /^[0-9a-f]{64,66}$/i;

const registerSchema = z.object({
  endpoint_url: z.string().url().max(2048),
  http_method: z.enum(['GET', 'POST']),
  operator_pubkey: z.string().regex(PUBKEY_RE, 'pubkey must be 64-66 hex chars'),
  domain: z.string().min(3).max(253),
  // OpenAPI 3 doc capped at 64 KB by the service ; Zod accepts any object.
  openapi_json: z.unknown().optional(),
  recall_body_template: z.string().max(4096).optional(),
  recommended_validators: z
    .array(
      z
        .string()
        .regex(/^(min_bytes|content_type|has_field|contains):.{1,200}$/),
    )
    .max(10)
    .optional(),
  expected_price_sats_min: z.number().int().nonnegative().max(100000).optional(),
  expected_price_sats_max: z.number().int().nonnegative().max(100000).optional(),
  bond_id: z.number().int().positive().optional(),
  signature_b64: z.string().min(20).max(512),
});

export interface OperatorRegistrationControllerDeps {
  service: OperatorEndpointRegistrationService;
  repo: OperatorEndpointRegistrationRepository;
  enabled: boolean;
}

export class OperatorRegistrationController {
  constructor(private readonly deps: OperatorRegistrationControllerDeps) {}

  private fullUrl(req: Request): string {
    return `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`;
  }

  /** POST /api/operator/register-endpoint
   *  NIP-98 signed by the operator's Nostr key.
   *  The body's operator_pubkey field SHOULD match the NIP-98 pubkey ;
   *  the controller enforces this so an attacker can't register an
   *  endpoint claiming to be a different operator. */
  register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!this.deps.enabled) {
        res.status(503).json({ error: 'operator_registration_disabled' });
        return;
      }

      const authHeader = req.headers.authorization;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? null;
      const auth = await verifyNip98(authHeader, 'POST', this.fullUrl(req), rawBody);
      if (!auth.valid || !auth.pubkey) {
        res.status(401).json({ error: 'invalid_auth' });
        return;
      }

      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'invalid_body',
          details: parsed.error.issues.slice(0, 5),
        });
        return;
      }
      const body = parsed.data;

      // Audit gate : the NIP-98 pubkey must match the declared operator_pubkey.
      // This blocks "I sign as agent A, register as operator B" attacks.
      if (body.operator_pubkey.toLowerCase() !== auth.pubkey.toLowerCase()) {
        res.status(403).json({
          error: 'operator_pubkey_mismatch',
          message: 'NIP-98 pubkey must match operator_pubkey field',
        });
        return;
      }

      try {
        const reg = await this.deps.service.registerEndpoint(body);
        logger.info(
          {
            registration_id: reg.registration_id,
            endpoint_url: reg.endpoint_url,
            operator: reg.operator_pubkey.slice(0, 12),
          },
          'OperatorRegistration: registration accepted (Phase 10)',
        );
        res.status(201).json({
          status: 'pending_verification',
          registration_id: reg.registration_id,
          endpoint_url: reg.endpoint_url,
          state: reg.state,
          dns_txt_required: `_satrank-operator.${reg.domain}`,
          dns_txt_value: `satrank-operator-pubkey=${reg.operator_pubkey}`,
          message:
            'Add the DNS TXT record above to verify ownership. The verification cron will pick up the change within 60 seconds.',
        });
      } catch (err) {
        if (err instanceof InvalidRegistrationError || err instanceof InvalidDomainError) {
          res.status(400).json({ error: 'invalid_registration', message: err.message });
          return;
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/operator/:pubkey/dashboard — public read of the operator's
   *  registrations + aggregate stats. No auth required ; the data is
   *  already public (endpoint URLs, verification states). */
  dashboard = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const pubkeyParam = req.params.pubkey;
      if (typeof pubkeyParam !== 'string' || !PUBKEY_RE.test(pubkeyParam)) {
        res.status(400).json({ error: 'invalid_pubkey' });
        return;
      }
      const [registrations, stats] = await Promise.all([
        this.deps.repo.findByOperator(pubkeyParam),
        this.deps.repo.dashboardStats(pubkeyParam),
      ]);
      res.status(200).json({
        data: {
          operator_pubkey: pubkeyParam,
          stats,
          registrations: registrations.map(r => ({
            registration_id: r.registration_id,
            endpoint_url: r.endpoint_url,
            http_method: r.http_method,
            domain: r.domain,
            state: r.state,
            registered_at: r.registered_at,
            verified_at: r.verified_at,
            fulfill_count: r.fulfill_count,
            fulfill_success_count: r.fulfill_success_count,
            expected_price_sats_min: r.expected_price_sats_min,
            expected_price_sats_max: r.expected_price_sats_max,
            bond_id: r.bond_id,
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  };
}
