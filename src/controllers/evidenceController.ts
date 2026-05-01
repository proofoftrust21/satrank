// Phase 8.3 (2026-05-01) — Evidence receipt HTTP surface.
//
// GET /api/fulfill/:job_id/evidence
//   NIP-98 by agent_pubkey owning the job.
//   Returns the SatRank-signed receipt for the first successful attempt.
//   Lazy-issues + caches in evidence_receipts.
import type { Request, Response, NextFunction } from 'express';
import { verifyNip98 } from '../middleware/nip98';
import { logger } from '../logger';
import type { FulfillJobRepository } from '../repositories/fulfillJobRepository';
import type { EvidenceService } from '../services/evidenceService';

const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EvidenceControllerDeps {
  evidenceService: EvidenceService;
  fulfillJobRepo: FulfillJobRepository;
  enabled: boolean;
}

export class EvidenceController {
  constructor(private readonly deps: EvidenceControllerDeps) {}

  private fullUrl(req: Request): string {
    return `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`;
  }

  show = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!this.deps.enabled) {
        res.status(503).json({ error: 'fulfill_disabled' });
        return;
      }
      const jobIdParam = req.params.job_id;
      const jobId = Array.isArray(jobIdParam) ? jobIdParam[0] : jobIdParam;
      if (!jobId || !JOB_ID_RE.test(jobId)) {
        res.status(400).json({ error: 'invalid_job_id' });
        return;
      }
      const authHeader = req.headers.authorization;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? null;
      const auth = await verifyNip98(authHeader, 'GET', this.fullUrl(req), rawBody);
      if (!auth.valid || !auth.pubkey) {
        res.status(401).json({ error: 'invalid_auth' });
        return;
      }
      const job = await this.deps.fulfillJobRepo.findById(jobId);
      if (!job) {
        res.status(404).json({ error: 'job_not_found' });
        return;
      }
      // The successful attempt (first delivery_ok). For refunded jobs (no
      // success attempt) we return 409 — refund-receipts are a Phase 8.3.1
      // follow-up.
      const attemptIndex = this.deps.evidenceService.findSuccessfulAttemptIndex(job);
      if (attemptIndex == null) {
        res.status(409).json({
          error: 'no_successful_attempt',
          status: job.status,
          message: 'Evidence receipts are issued only for delivery_ok attempts (Phase 8.3 v1).',
        });
        return;
      }

      const result = await this.deps.evidenceService.issue(jobId, attemptIndex, auth.pubkey);
      switch (result.status) {
        case 'ok':
          res.status(200).json({
            data: {
              receipt_id: result.receipt.receipt_id,
              job_id: result.receipt.job_id,
              attempt_index: result.receipt.attempt_index,
              payload_canonical_json: result.receipt.payload_canonical_json,
              payload_sha256: result.receipt.payload_sha256,
              signature_b64: result.receipt.signature_b64,
              satrank_pubkey: result.receipt.satrank_pubkey,
              signed_at_iso: result.receipt.signed_at_iso,
              tsa_token_b64: result.receipt.tsa_token_b64,
              tsa_authority_url: result.receipt.tsa_authority_url,
              algorithm: 'ed25519',
              verifier_doc: 'https://satrank.dev/docs/evidence-verification',
              well_known_pubkey_url: '/.well-known/satrank-key',
            },
          });
          return;
        case 'agent_mismatch':
          res.status(404).json({ error: 'job_not_found' });
          return;
        case 'job_not_success':
          res.status(409).json({ error: 'job_not_success', status: 'see /api/fulfill response' });
          return;
        case 'signing_disabled':
          res.status(503).json({
            error: 'signing_disabled',
            message: 'SatRank signing is not configured on this server',
          });
          return;
        case 'job_not_found':
        case 'attempt_not_found':
        case 'attempt_not_delivery_ok':
          res.status(404).json({ error: result.status });
          return;
        default:
          res.status(500).json({ error: 'unexpected_status' });
          return;
      }
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'EvidenceController: error');
      next(err);
    }
  };
}
