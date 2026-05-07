// Phase 11B.1 (2026-05-04) — Agent bond HTTP surface.
//
// POST /api/agent/bond/deposit  (NIP-98 auth)
//   Body : { bond_sats, min_floor_sats?, cooldown_sec?, memo? }
//   Issues a Lightning hold-invoice the agent pays to back the bond.
//   On settlement (external watcher) the bond becomes 'active'.
//
// GET /api/agent/bond  (NIP-98 auth)
//   Returns the agent's active bonds + aggregate available_sats. Used by
//   agents to know their tier (bronze/silver/gold) and remaining capacity.
//
// POST /api/agent/bond/:bond_id/freeze  (NIP-98 auth)
//   Agent-initiated freeze (no new slashes accepted). Owner-only.
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { verifyNip98, buildCanonicalNip98Url } from '../middleware/nip98';
import { config } from '../config';
import { logger } from '../logger';
import { sendError } from '../errors/errorEnvelope';
import type { AgentBondService } from '../services/agentBondService';

const depositSchema = z.object({
  bond_sats: z.number().int().min(1000).max(10_000_000),
  min_floor_sats: z.number().int().min(0).max(1_000_000).optional(),
  cooldown_sec: z.number().int().min(86400).max(90 * 86400).optional(),
  memo: z.string().max(200).optional(),
});

const BOND_ID_RE = /^\d+$/;

export interface AgentBondControllerDeps {
  service: AgentBondService;
  enabled: boolean;
}

export class AgentBondController {
  constructor(private readonly deps: AgentBondControllerDeps) {}

  private fullUrl(req: Request): string {
    // Phase 12A audit fix HIGH-2 — canonical URL from config, no Host trust.
    return buildCanonicalNip98Url(req, config.SATRANK_API_BASE);
  }

  deposit = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!this.deps.enabled) {
        sendError(res, 'fulfill_disabled', { message: 'agent bonds are gated behind FULFILL_ENABLED' });
        return;
      }
      const authHeader = req.headers.authorization;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? null;
      const auth = await verifyNip98(authHeader, 'POST', this.fullUrl(req), rawBody);
      if (!auth.valid || !auth.pubkey) {
        sendError(res, 'invalid_auth');
        return;
      }
      const parsed = depositSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 'invalid_body', { details: parsed.error.issues.slice(0, 5) });
        return;
      }
      const result = await this.deps.service.createDeposit({
        agent_pubkey: auth.pubkey,
        bond_sats: parsed.data.bond_sats,
        min_floor_sats: parsed.data.min_floor_sats,
        cooldown_sec: parsed.data.cooldown_sec,
        memo: parsed.data.memo,
      });
      switch (result.status) {
        case 'invoice_issued':
          logger.info(
            { agent: auth.pubkey.slice(0, 12), bond_id: result.bond_id, bond_sats: parsed.data.bond_sats },
            'AgentBond: deposit invoice issued (Phase 11B.1)',
          );
          res.status(201).json({
            status: 'invoice_issued',
            bond_id: result.bond_id,
            payment_request: result.payment_request,
            payment_hash: result.payment_hash,
            expires_at: result.expires_at,
            message: 'pay the BOLT11 above ; on settlement the bond becomes active',
          });
          return;
        case 'lnd_unavailable':
          sendError(res, 'lnd_unavailable', { message: result.reason });
          return;
        case 'invalid_request':
          sendError(res, 'invalid_body', { message: result.reason });
          return;
      }
    } catch (err) {
      next(err);
    }
  };

  status = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!this.deps.enabled) {
        sendError(res, 'fulfill_disabled');
        return;
      }
      const authHeader = req.headers.authorization;
      const auth = await verifyNip98(authHeader, 'GET', this.fullUrl(req), null);
      if (!auth.valid || !auth.pubkey) {
        sendError(res, 'invalid_auth');
        return;
      }
      const [bonds, available] = await Promise.all([
        this.deps.service.listForAgent(auth.pubkey),
        this.deps.service.availableForAgent(auth.pubkey),
      ]);
      res.status(200).json({
        data: {
          agent_pubkey: auth.pubkey,
          available_sats: available,
          bonds: bonds.map(b => ({
            bond_id: b.bond_id,
            bond_committed_sats: b.bond_committed_sats,
            bond_slashed_sats: b.bond_slashed_sats,
            bond_pending_sats: b.bond_pending_sats,
            available_sats: b.bond_committed_sats - b.bond_slashed_sats - b.bond_pending_sats,
            min_floor_sats: b.min_floor_sats,
            state: b.state,
            created_at: b.created_at,
            releasable_at: b.releasable_at,
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  freeze = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!this.deps.enabled) {
        sendError(res, 'fulfill_disabled');
        return;
      }
      const authHeader = req.headers.authorization;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? null;
      const auth = await verifyNip98(authHeader, 'POST', this.fullUrl(req), rawBody);
      if (!auth.valid || !auth.pubkey) {
        sendError(res, 'invalid_auth');
        return;
      }
      const bondIdParam = req.params.bond_id;
      if (typeof bondIdParam !== 'string' || !BOND_ID_RE.test(bondIdParam)) {
        sendError(res, 'invalid_body', { message: 'bond_id must be a positive integer' });
        return;
      }
      const ok = await this.deps.service.freeze(Number(bondIdParam), auth.pubkey);
      if (!ok) {
        sendError(res, 'invalid_body', { message: 'bond not found, not owned by you, or already non-active' });
        return;
      }
      res.status(200).json({ status: 'frozen', bond_id: Number(bondIdParam) });
    } catch (err) {
      next(err);
    }
  };
}
