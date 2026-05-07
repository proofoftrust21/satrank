// AEPS §10 (2026-05-07) — Dispute HTTP surface.
//
// POST /api/aeps/dispute  (NIP-98 auth, disputant_pubkey from auth)
//   Body : { respondent_pubkey, dispute_type, receipt_id?, fork_event_id?,
//            oracle_pubkeys[], oracle_threshold, ttl_sec?, dispute_reason? }
//   Opens a dispute. Returns dispute_id + outcome message hashes the
//   oracles will sign.
//
// POST /api/aeps/dispute/:dispute_id/attestation  (NIP-98 auth)
//   Body : { outcome, signature_hex }
//   Submits a Schnorr attestation. Caller's pubkey is the oracle_pubkey.
//   When threshold reached, the dispute resolves automatically.
//
// GET /api/aeps/dispute/:dispute_id  (public read)
//   Returns dispute state + counts of attestations per outcome.
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { verifyNip98, buildCanonicalNip98Url } from '../middleware/nip98';
import { config } from '../config';
import { sendError } from '../errors/errorEnvelope';
import {
  type DisputeService,
  buildOutcomeMessage,
  buildOutcomeMessageHash,
} from '../services/disputeService';
import type { AepsDisputeRepository } from '../repositories/aepsDisputeRepository';

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

const openDisputeSchema = z.object({
  respondent_pubkey: z.string().regex(HEX64),
  dispute_type: z.enum(['content_correctness', 'sla_breach', 'fork', 'non_payment', 'false_dispute']),
  receipt_id: z.number().int().positive().optional(),
  fork_event_id: z.number().int().positive().optional(),
  oracle_pubkeys: z.array(z.string().regex(HEX64)).min(1).max(32),
  oracle_threshold: z.number().int().min(1).max(32),
  ttl_sec: z.number().int().min(60).max(30 * 24 * 3600).optional(),
  dispute_reason: z.string().max(500).optional(),
});

const attestationSchema = z.object({
  outcome: z.enum(['disputant_wins', 'respondent_wins']),
  signature_hex: z.string().regex(HEX128),
});

export interface AepsDisputeControllerDeps {
  disputeService: DisputeService;
  disputeRepo: AepsDisputeRepository;
}

export class AepsDisputeController {
  constructor(private readonly deps: AepsDisputeControllerDeps) {}

  private fullUrl(req: Request): string {
    // Phase 12A audit fix HIGH-2 — see fulfillController for rationale.
    return buildCanonicalNip98Url(req, config.SATRANK_API_BASE);
  }

  open = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authHeader = req.headers.authorization;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? null;
      const auth = await verifyNip98(authHeader, 'POST', this.fullUrl(req), rawBody);
      if (!auth.valid || !auth.pubkey) {
        sendError(res, 'invalid_auth');
        return;
      }
      const parsed = openDisputeSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 'invalid_body', { details: parsed.error.issues.slice(0, 5) });
        return;
      }
      const result = await this.deps.disputeService.openDispute({
        disputant_pubkey: auth.pubkey,
        respondent_pubkey: parsed.data.respondent_pubkey,
        dispute_type: parsed.data.dispute_type,
        receipt_id: parsed.data.receipt_id,
        fork_event_id: parsed.data.fork_event_id,
        oracle_pubkeys: parsed.data.oracle_pubkeys,
        oracle_threshold: parsed.data.oracle_threshold,
        ttl_sec: parsed.data.ttl_sec,
        dispute_reason: parsed.data.dispute_reason,
      });
      if (result.status !== 'ok') {
        sendError(res, 'invalid_body', { message: result.reason });
        return;
      }
      // Echo the canonical messages oracles will sign for each outcome.
      const disputeId = result.dispute.dispute_id;
      res.status(201).json({
        data: {
          dispute_id: disputeId,
          state: result.dispute.state,
          multiplier: result.dispute.multiplier,
          oracle_pubkeys: result.dispute.oracle_pubkeys,
          oracle_threshold: result.dispute.oracle_threshold,
          expires_at: result.dispute.expires_at,
          outcome_messages: {
            disputant_wins: {
              canonical: buildOutcomeMessage(disputeId, 'disputant_wins'),
              hash_hex: buildOutcomeMessageHash(disputeId, 'disputant_wins').toString('hex'),
            },
            respondent_wins: {
              canonical: buildOutcomeMessage(disputeId, 'respondent_wins'),
              hash_hex: buildOutcomeMessageHash(disputeId, 'respondent_wins').toString('hex'),
            },
          },
        },
      });
    } catch (err) {
      next(err);
    }
  };

  attest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const disputeId = String(req.params.dispute_id ?? '');
      if (!/^dis_[0-9a-f]{32}$/.test(disputeId)) {
        sendError(res, 'invalid_body', { message: 'dispute_id must be dis_<32-hex>' });
        return;
      }
      const authHeader = req.headers.authorization;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? null;
      const auth = await verifyNip98(authHeader, 'POST', this.fullUrl(req), rawBody);
      if (!auth.valid || !auth.pubkey) {
        sendError(res, 'invalid_auth');
        return;
      }
      const parsed = attestationSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 'invalid_body', { details: parsed.error.issues.slice(0, 5) });
        return;
      }
      const result = await this.deps.disputeService.submitAttestation(
        disputeId,
        auth.pubkey,
        parsed.data.outcome,
        parsed.data.signature_hex,
      );
      switch (result.status) {
        case 'ok':
          res.status(200).json({
            data: {
              dispute_id: disputeId,
              attestation_id: result.attestation.attestation_id,
              dispute_state: result.dispute_state,
            },
          });
          return;
        case 'dispute_not_found':
          sendError(res, 'dispute_not_found');
          return;
        case 'dispute_not_open':
          sendError(res, 'dispute_not_open', { message: `dispute is ${result.current}` });
          return;
        case 'oracle_not_in_set':
          sendError(res, 'oracle_not_in_set');
          return;
        case 'invalid_signature':
          sendError(res, 'signature_invalid');
          return;
        case 'invalid_input':
          sendError(res, 'invalid_body', { message: result.reason });
          return;
      }
    } catch (err) {
      next(err);
    }
  };

  get = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const disputeId = String(req.params.dispute_id ?? '');
      if (!/^dis_[0-9a-f]{32}$/.test(disputeId)) {
        sendError(res, 'invalid_body', { message: 'dispute_id must be dis_<32-hex>' });
        return;
      }
      const dispute = await this.deps.disputeRepo.findDispute(disputeId);
      if (!dispute) {
        sendError(res, 'dispute_not_found');
        return;
      }
      const attestations = await this.deps.disputeRepo.listAttestations(disputeId);
      const counts = { disputant_wins: 0, respondent_wins: 0 };
      for (const a of attestations) counts[a.outcome] += 1;
      res.status(200).json({
        data: {
          dispute_id: dispute.dispute_id,
          disputant_pubkey: dispute.disputant_pubkey,
          respondent_pubkey: dispute.respondent_pubkey,
          dispute_type: dispute.dispute_type,
          multiplier: dispute.multiplier,
          oracle_pubkeys: dispute.oracle_pubkeys,
          oracle_threshold: dispute.oracle_threshold,
          state: dispute.state,
          expires_at: dispute.expires_at,
          created_at: dispute.created_at,
          resolved_at: dispute.resolved_at,
          claim_id: dispute.claim_id,
          attestation_counts: counts,
          attestations: attestations.map(a => ({
            oracle_pubkey: a.oracle_pubkey,
            outcome: a.outcome,
            signed_at: a.signed_at,
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  };
}
