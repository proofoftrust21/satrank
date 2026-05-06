// AEPS §8 — Evidence anchor + inclusion-proof HTTP endpoints.
//
// GET /api/aeps/anchor/:day_utc          → one operator's daily anchor row
// GET /api/aeps/anchor/recent            → most recent N anchors for this op
// GET /api/aeps/proof/:receipt_id        → audit path for a receipt
//
// All three are read-only and unauthenticated (the L1 anchor + signed evidence
// payload is the trust root; serving the data publicly is the whole point of
// transparency). Rate-limiting is the global Express middleware.
import type { Request, Response, NextFunction } from 'express';
import type { DailyMerkleAnchorService } from '../services/dailyMerkleAnchorService';
import type { DailyMerkleAnchorRepository } from '../repositories/dailyMerkleAnchorRepository';

export interface AepsEvidenceControllerDeps {
  anchorService: DailyMerkleAnchorService;
  anchorRepo: DailyMerkleAnchorRepository;
  operatorPubkeyHex: string;
}

const DAY_UTC_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export class AepsEvidenceController {
  constructor(private readonly deps: AepsEvidenceControllerDeps) {}

  getAnchor = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const dayUtc = String(req.params.day_utc ?? '');
      if (!DAY_UTC_REGEX.test(dayUtc)) {
        res.status(400).json({
          error: { code: 'INVALID_DAY', message: 'day_utc must be YYYY-MM-DD' },
        });
        return;
      }
      const anchor = await this.deps.anchorRepo.findByDayOperator(dayUtc, this.deps.operatorPubkeyHex);
      if (!anchor) {
        res.status(404).json({
          error: { code: 'ANCHOR_NOT_FOUND', message: `no anchor for ${dayUtc}` },
        });
        return;
      }
      res.json({ data: serializeAnchor(anchor) });
    } catch (err) {
      next(err);
    }
  };

  listRecent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 30) || 30, 1), 366);
      const rows = await this.deps.anchorRepo.listRecent(this.deps.operatorPubkeyHex, limit);
      res.json({ data: rows.map(serializeAnchor) });
    } catch (err) {
      next(err);
    }
  };

  getProof = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const receiptId = Number(req.params.receipt_id);
      if (!Number.isInteger(receiptId) || receiptId <= 0) {
        res.status(400).json({
          error: { code: 'INVALID_RECEIPT_ID', message: 'receipt_id must be a positive integer' },
        });
        return;
      }
      const proof = await this.deps.anchorService.buildInclusionProof(receiptId);
      if (!proof) {
        res.status(404).json({
          error: { code: 'PROOF_NOT_AVAILABLE', message: 'no anchor or receipt for that id' },
        });
        return;
      }
      res.json({ data: proof });
    } catch (err) {
      next(err);
    }
  };
}

function serializeAnchor(a: {
  day_utc: string;
  operator_pubkey: string;
  root_hex: string;
  receipt_count: number;
  receipt_first_id: number | null;
  receipt_last_id: number | null;
  l1_txid: string | null;
  l1_block_height: number | null;
  l1_broadcast_at: number | null;
  nostr_event_id: string | null;
  nostr_published_at: number | null;
  computed_at: number;
}): Record<string, unknown> {
  return {
    day_utc: a.day_utc,
    operator_pubkey: a.operator_pubkey,
    root_hex: a.root_hex,
    receipt_count: a.receipt_count,
    receipt_first_id: a.receipt_first_id,
    receipt_last_id: a.receipt_last_id,
    l1_txid: a.l1_txid,
    l1_block_height: a.l1_block_height,
    l1_broadcast_at: a.l1_broadcast_at,
    nostr_event_id: a.nostr_event_id,
    nostr_published_at: a.nostr_published_at,
    computed_at: a.computed_at,
  };
}
