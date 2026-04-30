// Phase 2 (2026-05-01) — POST /api/dispute/:ledger_id
//
// An operator whose endpoint received a Tier 2 body-shape refund (= we paid
// them but classified the response as low-quality and refunded the agent)
// can NIP-98-sign a contest within a 24h window. We verify:
//   1. Valid NIP-98 (signer pubkey, payload binding)
//   2. Signer pubkey owns the candidate_url via operator_owns_endpoint
//   3. The refund is Tier 2 (Tier 1 HTTP non-2xx is not disputable — the
//      operator's own server returned the 4xx/5xx)
//   4. No prior dispute by this operator for this ledger row (UNIQUE)
//
// Resolution is reputational only — Phase 3 will accept disputes by
// lifting the negative attempt observation from stage_posteriors. The
// agent is never re-debited; "winning" a dispute restores the operator's
// rank impact, not money flow.
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { verifyNip98 } from '../middleware/nip98';
import { logger } from '../logger';
import { ValidationError } from '../errors';
import { formatZodError } from '../utils/zodError';
import { endpointHash } from '../utils/urlCanonical';
import type { RefundLedgerRepository } from '../repositories/refundLedgerRepository';
import type { RefundDisputeRepository } from '../repositories/refundDisputeRepository';
import type { OperatorService } from '../services/operatorService';

const disputeBodySchema = z.object({
  reason: z.string().min(1).max(500),
  evidence: z.record(z.unknown()).optional(),
});

export interface DisputeControllerDeps {
  refundLedgerRepo: RefundLedgerRepository;
  refundDisputeRepo: RefundDisputeRepository;
  operatorService: OperatorService;
}

export class DisputeController {
  private readonly refundLedgerRepo: RefundLedgerRepository;
  private readonly refundDisputeRepo: RefundDisputeRepository;
  private readonly operatorService: OperatorService;

  constructor(deps: DisputeControllerDeps) {
    this.refundLedgerRepo = deps.refundLedgerRepo;
    this.refundDisputeRepo = deps.refundDisputeRepo;
    this.operatorService = deps.operatorService;
  }

  private fullUrl(req: Request): string {
    return `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`;
  }

  open = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Step 1 — NIP-98 auth.
      const authHeader = req.headers.authorization;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? null;
      const auth = await verifyNip98(authHeader, 'POST', this.fullUrl(req), rawBody);
      if (!auth.valid || !auth.pubkey || !auth.event_id) {
        logger.warn(
          { detail: auth.detail, route: '/api/dispute' },
          'NIP-98 rejected on /api/dispute',
        );
        res.status(401).json({ error: 'invalid_auth', message: 'NIP-98 verification failed' });
        return;
      }

      // Step 2 — body validation.
      const parsed = disputeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(formatZodError(parsed.error, req.body));
      }
      const { reason, evidence } = parsed.data;

      // Step 3 — ledger row exists?
      const ledgerIdParam = req.params.ledger_id;
      const ledgerIdStr = Array.isArray(ledgerIdParam) ? ledgerIdParam[0] : ledgerIdParam;
      const ledgerId = Number.parseInt(ledgerIdStr ?? '', 10);
      if (!Number.isInteger(ledgerId) || ledgerId <= 0) {
        res.status(400).json({ error: 'invalid_ledger_id', message: 'ledger_id must be a positive integer' });
        return;
      }
      const ledger = await this.refundLedgerRepo.findById(ledgerId);
      if (!ledger) {
        res.status(404).json({ error: 'not_found', message: `refund_ledger ${ledgerId} not found` });
        return;
      }

      // Step 4 — only Tier 2 is disputable. Tier 1 (HTTP non-2xx, network
      // errors) reflects the operator's own server response — there's no
      // factual ground for them to contest.
      if (!ledger.classification.startsWith('tier2_')) {
        res.status(409).json({
          error: 'not_disputable',
          message: `${ledger.classification} cannot be disputed (only tier2_* classifications)`,
          classification: ledger.classification,
        });
        return;
      }

      // Step 5 — verify the signer pubkey owns the candidate_url. The
      // operator_owns_endpoint relation is keyed by url_hash and stores the
      // npub directly as operator_id (see serviceRegisterController.ts
      // pattern — claimOwnership(auth.npub, 'endpoint', urlHash)).
      const urlHash = endpointHash(ledger.candidate_url);
      const ownership = await this.operatorService.resolveOperatorForEndpoint(urlHash);
      if (!ownership) {
        res.status(403).json({
          error: 'no_ownership_record',
          message: 'no operator_owns_endpoint relation for this candidate_url — claim it first via /api/services/register',
        });
        return;
      }
      if (ownership.operatorId !== auth.pubkey) {
        logger.warn(
          {
            ledger_id: ledgerId,
            signer: auth.pubkey.slice(0, 12),
            owner: ownership.operatorId.slice(0, 12),
          },
          'Dispute: signer is not the registered operator for the candidate_url',
        );
        res.status(403).json({
          error: 'not_endpoint_owner',
          message: 'NIP-98 signer pubkey does not match the registered owner of the candidate_url',
        });
        return;
      }

      // Step 6 — open the dispute. Idempotent on (ledger_id, operator_pubkey)
      // — re-submission returns 409 to make the duplicate explicit.
      const inserted = await this.refundDisputeRepo.open({
        ledger_id: ledgerId,
        operator_pubkey: auth.pubkey,
        reason,
        evidence,
        signed_event_id: auth.event_id,
        opened_at: Math.floor(Date.now() / 1000),
      });
      if (!inserted) {
        res.status(409).json({
          error: 'already_disputed',
          message: 'this operator already has a dispute against this ledger entry',
        });
        return;
      }

      logger.info(
        {
          dispute_id: inserted.dispute_id,
          ledger_id: ledgerId,
          operator: auth.pubkey.slice(0, 12),
          classification: ledger.classification,
        },
        'Dispute: opened',
      );
      res.status(201).json({
        status: 'open',
        dispute_id: inserted.dispute_id,
        ledger_id: ledgerId,
        opened_at: inserted.opened_at,
        message: 'dispute recorded — auto-rejected after 24h if no Phase 3 admin resolution',
      });
    } catch (err) {
      next(err);
    }
  };

  show = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const disputeIdParam = req.params.dispute_id;
      const disputeIdStr = Array.isArray(disputeIdParam) ? disputeIdParam[0] : disputeIdParam;
      const disputeId = Number.parseInt(disputeIdStr ?? '', 10);
      if (!Number.isInteger(disputeId) || disputeId <= 0) {
        res.status(400).json({ error: 'invalid_dispute_id' });
        return;
      }
      const dispute = await this.refundDisputeRepo.findById(disputeId);
      if (!dispute) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ data: dispute });
    } catch (err) {
      next(err);
    }
  };
}
