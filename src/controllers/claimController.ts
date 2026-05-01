// Phase 7.5 (2026-05-01) — Claims dispute + public stats endpoints.
//
// Operator-side: POST /api/operator/claim/:claim_id/dispute — operator files
// a dispute against a pending claim, NIP-98-signed by the operator pubkey
// owning the bond. Transitions claim from `pending` → `disputed`. The
// payout cron then refuses to pay until the dispute is manually resolved
// (Phase 7.5.1 will auto-reject after 7d ; v1 is manual only).
//
// Public: GET /api/oracle/claims — 24h aggregate stats (count by state, total
// sats slashed, total sats paid to agents). No PII exposed.
import type { Request, Response, NextFunction } from 'express';
import { verifyNip98 } from '../middleware/nip98';
import { logger } from '../logger';
import type { AgentClaimRepository } from '../repositories/agentClaimRepository';
import type { OperatorBondRepository } from '../repositories/operatorBondRepository';

export interface ClaimControllerDeps {
  claimRepo: AgentClaimRepository;
  // bondRepo retained for backward compatibility ; dispute path now uses
  // claimRepo.findDisputableByOperator (single-query JOIN, audit H4).
  bondRepo: OperatorBondRepository;
  enabled: boolean;
}

const CLAIM_ID_RE = /^\d{1,18}$/;

export class ClaimController {
  constructor(private readonly deps: ClaimControllerDeps) {}

  private fullUrl(req: Request): string {
    return `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`;
  }

  /** POST /api/operator/claim/:claim_id/dispute
   *  NIP-98 signed by the operator owning the bond on the claim. */
  fileDispute = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!this.deps.enabled) {
        res.status(503).json({ error: 'fulfill_disabled' });
        return;
      }
      const claimIdParam = req.params.claim_id;
      const claimIdStr = Array.isArray(claimIdParam) ? claimIdParam[0] : claimIdParam;
      if (!claimIdStr || !CLAIM_ID_RE.test(claimIdStr)) {
        res.status(400).json({ error: 'invalid_claim_id' });
        return;
      }
      const claimId = Number(claimIdStr);

      const authHeader = req.headers.authorization;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? null;
      const auth = await verifyNip98(authHeader, 'POST', this.fullUrl(req), rawBody);
      if (!auth.valid || !auth.pubkey) {
        res.status(401).json({ error: 'invalid_auth' });
        return;
      }

      // Audit H4 — single JOIN query collapses (claim missing) + (bond
      // missing) + (operator mismatch) into one constant-time path. State
      // check happens AFTER the existence/ownership gate so we don't
      // leak "claim exists in unexpected state" via differential responses.
      const claim = await this.deps.claimRepo.findDisputableByOperator(
        claimId,
        auth.pubkey,
      );
      if (!claim) {
        res.status(404).json({ error: 'claim_not_found' });
        return;
      }
      if (claim.state !== 'pending') {
        res.status(409).json({ error: 'claim_not_disputable', current_state: claim.state });
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const filed = await this.deps.claimRepo.fileDispute(claimId, now);
      if (!filed) {
        res.status(409).json({ error: 'race_condition' });
        return;
      }
      logger.info(
        { claim_id: claimId, operator_pubkey: auth.pubkey.slice(0, 12) },
        'ClaimController: dispute filed (Phase 7.5)',
      );
      res.status(200).json({
        status: 'dispute_filed',
        claim_id: claimId,
        dispute_filed_at: now,
        message: 'Claim dispute pending review. Payout cron will skip this claim until manually resolved.',
      });
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/oracle/claims — public aggregate stats (24h). No PII. */
  oracleClaims = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const stats = await this.deps.claimRepo.statsLast24h(Math.floor(Date.now() / 1000));
      res.status(200).json({
        data: {
          window_sec: 86400,
          stats,
          message: 'Phase 7 claim engine — operator bond slashing on Tier 2+ delivery failures.',
        },
      });
    } catch (err) {
      next(err);
    }
  };
}
