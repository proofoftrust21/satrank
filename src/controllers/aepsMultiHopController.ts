// AEPS §6.3 (2026-05-08) — Multi-hop HTLC chain HTTP surface.
//
// All routes are NIP-98 auth except GET (public).
// Owner enforcement : only the agent_pubkey that planned the chain may
// drive subsequent state transitions (lock, reveal, settle, abort).
//
// POST /api/aeps/multihop/plan
//   body : { legs: [{endpoint_id, operator_pubkey, amount_msat,
//                    request_body_sha256}], ttl_sec? }
//   → 201 { chain_id, preimage_hex (one-shot, store carefully),
//           preimage_hash, expires_at, n_legs, total_amount_msat }
//
// POST /api/aeps/multihop/:chain_id/lock
//   body : { leg_index, htlc_ref }
//   → 200 { chain_state }
//
// POST /api/aeps/multihop/:chain_id/reveal
//   body : { preimage_hex }
//   → 200 { dispute_state: 'settling' }
//
// POST /api/aeps/multihop/:chain_id/settle
//   body : { leg_index }
//   → 200 { chain_state }
//
// POST /api/aeps/multihop/:chain_id/abort
//   body : { reason }
//   → 200 { legs_aborted }
//
// GET /api/aeps/multihop/:chain_id
//   → 200 { chain + legs[] }
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { verifyNip98 } from '../middleware/nip98';
import { sendError } from '../errors/errorEnvelope';
import type {
  MultiHopChainService,
} from '../services/multiHopChainService';
import type { MultiHopChainRepository } from '../repositories/multiHopChainRepository';

const HEX64 = /^[0-9a-f]{64}$/;
const CHAIN_ID_RE = /^mhc_[0-9a-f]{32}$/;

const planSchema = z.object({
  legs: z
    .array(
      z.object({
        endpoint_id: z.string().min(1).max(128),
        operator_pubkey: z.string().regex(HEX64),
        amount_msat: z.number().int().min(1).max(1_000_000_000),
        request_body_sha256: z.string().regex(HEX64),
      }),
    )
    .min(2)
    .max(16),
  ttl_sec: z.number().int().min(60).max(86_400).optional(),
});

const lockSchema = z.object({
  leg_index: z.number().int().min(0).max(15),
  htlc_ref: z.string().min(1).max(256),
});

const revealSchema = z.object({
  preimage_hex: z.string().regex(HEX64),
});

const settleSchema = z.object({
  leg_index: z.number().int().min(0).max(15),
});

const abortSchema = z.object({
  reason: z.string().min(1).max(200),
});

export interface AepsMultiHopControllerDeps {
  service: MultiHopChainService;
  repo: MultiHopChainRepository;
}

export class AepsMultiHopController {
  constructor(private readonly deps: AepsMultiHopControllerDeps) {}

  private fullUrl(req: Request): string {
    return `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`;
  }

  /** Resolve chain by id and assert the caller is the owner agent_pubkey. */
  private async loadOwnedChain(
    req: Request,
    res: Response,
  ): Promise<{ ok: true; chain_id: string; agent_pubkey: string } | { ok: false }> {
    const chainId = String(req.params.chain_id ?? '');
    if (!CHAIN_ID_RE.test(chainId)) {
      sendError(res, 'invalid_body', { message: 'chain_id must be mhc_<32-hex>' });
      return { ok: false };
    }
    const authHeader = req.headers.authorization;
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? null;
    const auth = await verifyNip98(authHeader, 'POST', this.fullUrl(req), rawBody);
    if (!auth.valid || !auth.pubkey) {
      sendError(res, 'invalid_auth');
      return { ok: false };
    }
    const chain = await this.deps.repo.findChain(chainId);
    if (!chain) {
      sendError(res, 'invalid_body', { message: 'chain not found', http_status: 404 });
      return { ok: false };
    }
    if (chain.agent_pubkey.toLowerCase() !== auth.pubkey.toLowerCase()) {
      sendError(res, 'invalid_auth', { message: 'caller pubkey is not the chain owner' });
      return { ok: false };
    }
    return { ok: true, chain_id: chainId, agent_pubkey: auth.pubkey };
  }

  plan = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authHeader = req.headers.authorization;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? null;
      const auth = await verifyNip98(authHeader, 'POST', this.fullUrl(req), rawBody);
      if (!auth.valid || !auth.pubkey) {
        sendError(res, 'invalid_auth');
        return;
      }
      const parsed = planSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 'invalid_body', { details: parsed.error.issues.slice(0, 5) });
        return;
      }
      const result = await this.deps.service.planChain({
        agent_pubkey: auth.pubkey,
        legs: parsed.data.legs,
        ttl_sec: parsed.data.ttl_sec,
      });
      if (result.status !== 'ok') {
        sendError(res, 'invalid_body', { message: result.reason });
        return;
      }
      res.status(201).json({
        data: {
          chain_id: result.chain.chain_id,
          n_legs: result.chain.n_legs,
          total_amount_msat: result.chain.total_amount_msat,
          preimage_hash: result.chain.preimage_hash,
          // CRITICAL : preimage_hex is returned exactly once. The agent MUST
          // persist it locally before locking any leg ; loss of preimage
          // before settle = permanent loss of all locked legs.
          preimage_hex: result.preimage_hex,
          expires_at: result.chain.expires_at,
          state: result.chain.state,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  lock = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const owned = await this.loadOwnedChain(req, res);
      if (!owned.ok) return;
      const parsed = lockSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 'invalid_body', { details: parsed.error.issues.slice(0, 5) });
        return;
      }
      const result = await this.deps.service.lockLeg(
        owned.chain_id,
        parsed.data.leg_index,
        parsed.data.htlc_ref,
      );
      this.respondLeg(res, result);
    } catch (err) {
      next(err);
    }
  };

  reveal = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const owned = await this.loadOwnedChain(req, res);
      if (!owned.ok) return;
      const parsed = revealSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 'invalid_body', { details: parsed.error.issues.slice(0, 5) });
        return;
      }
      const result = await this.deps.service.revealPreimage(owned.chain_id, parsed.data.preimage_hex);
      switch (result.status) {
        case 'ok':
          res.status(200).json({ data: { dispute_state: 'settling' } });
          return;
        case 'chain_not_found':
          sendError(res, 'invalid_body', { message: 'chain not found', http_status: 404 });
          return;
        case 'preimage_mismatch':
          sendError(res, 'invalid_body', { message: 'preimage does not match preimage_hash' });
          return;
        case 'invalid_state':
          sendError(res, 'invalid_body', { message: `chain is ${result.current}` });
          return;
      }
    } catch (err) {
      next(err);
    }
  };

  settle = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const owned = await this.loadOwnedChain(req, res);
      if (!owned.ok) return;
      const parsed = settleSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 'invalid_body', { details: parsed.error.issues.slice(0, 5) });
        return;
      }
      const result = await this.deps.service.settleLeg(owned.chain_id, parsed.data.leg_index);
      this.respondLeg(res, result);
    } catch (err) {
      next(err);
    }
  };

  abort = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const owned = await this.loadOwnedChain(req, res);
      if (!owned.ok) return;
      const parsed = abortSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 'invalid_body', { details: parsed.error.issues.slice(0, 5) });
        return;
      }
      const result = await this.deps.service.abortChain(owned.chain_id, parsed.data.reason);
      switch (result.status) {
        case 'ok':
          res.status(200).json({ data: { legs_aborted: result.legs_aborted } });
          return;
        case 'chain_not_found':
          sendError(res, 'invalid_body', { message: 'chain not found', http_status: 404 });
          return;
        case 'already_terminal':
          sendError(res, 'invalid_body', { message: `chain is ${result.current}` });
          return;
      }
    } catch (err) {
      next(err);
    }
  };

  get = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const chainId = String(req.params.chain_id ?? '');
      if (!CHAIN_ID_RE.test(chainId)) {
        sendError(res, 'invalid_body', { message: 'chain_id must be mhc_<32-hex>' });
        return;
      }
      const chain = await this.deps.repo.findChain(chainId);
      if (!chain) {
        sendError(res, 'invalid_body', { message: 'chain not found', http_status: 404 });
        return;
      }
      const legs = await this.deps.repo.listLegs(chainId);
      res.status(200).json({
        data: {
          chain_id: chain.chain_id,
          agent_pubkey: chain.agent_pubkey,
          preimage_hash: chain.preimage_hash,
          // preimage_revealed is publicly visible only after reveal
          // (cryptographically self-verifying).
          preimage_revealed: chain.preimage_revealed,
          total_amount_msat: chain.total_amount_msat,
          n_legs: chain.n_legs,
          state: chain.state,
          created_at: chain.created_at,
          expires_at: chain.expires_at,
          settled_at: chain.settled_at,
          aborted_at: chain.aborted_at,
          abort_reason: chain.abort_reason,
          legs: legs.map(l => ({
            leg_index: l.leg_index,
            endpoint_id: l.endpoint_id,
            operator_pubkey: l.operator_pubkey,
            amount_msat: l.amount_msat,
            request_body_sha256: l.request_body_sha256,
            state: l.state,
            htlc_ref: l.htlc_ref,
            fulfilled_response_sha256: l.fulfilled_response_sha256,
            locked_at: l.locked_at,
            fulfilled_at: l.fulfilled_at,
            settled_at: l.settled_at,
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  private respondLeg(
    res: Response,
    result:
      | { status: 'ok'; chain_state: string }
      | { status: 'chain_not_found' }
      | { status: 'leg_not_found' }
      | { status: 'invalid_state'; current: string },
  ): void {
    switch (result.status) {
      case 'ok':
        res.status(200).json({ data: { chain_state: result.chain_state } });
        return;
      case 'chain_not_found':
        sendError(res, 'invalid_body', { message: 'chain not found', http_status: 404 });
        return;
      case 'leg_not_found':
        sendError(res, 'invalid_body', { message: 'leg_index out of range', http_status: 404 });
        return;
      case 'invalid_state':
        sendError(res, 'invalid_body', { message: `leg or chain is ${result.current}` });
        return;
    }
  }
}
