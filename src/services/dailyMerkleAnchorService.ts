// AEPS §8 (2026-05-07) — Daily Merkle anchor service.
//
// Computes the daily Merkle root over evidence_receipts and (optionally)
// broadcasts the root in an OP_RETURN on Bitcoin L1. The L1 transaction is
// the trust root per AEPS-whitepaper §8 :
//
//   OP_RETURN <"AEPS1"> <operator_pubkey[8]> <day[4]> <root[32]>   — 45 bytes
//
// L1 broadcast is gated by env L1_ANCHOR_ENABLED (default off). Even with
// broadcast off, the daily root is still computed and persisted, so any
// party that fetches the root via /api/aeps/evidence/daily-anchor can verify
// inclusion. Activating L1 broadcast adds non-equivocation: an operator who
// signs two different daily roots produces two L1 txs — both public, both
// detectable, both slashable per AEPS §10.
//
// Determinism : leaves are SHA-256 of evidence_receipts.payload_sha256 (decoded
// from hex), ordered by ASC receipt_id. The same set of receipts always
// produces the same root.
import { logger } from '../logger';
import type { DailyMerkleAnchorRepository, DailyMerkleAnchor, ReceiptForAnchor } from '../repositories/dailyMerkleAnchorRepository';
import { merkleRoot, leafHash, inclusionProof, rootHex, pathHex } from './merkleTreeUtil';

export interface DailyMerkleAnchorServiceDeps {
  repo: DailyMerkleAnchorRepository;
  operatorPubkeyHex: string;
  now?: () => number;
}

export interface ComputeResult {
  status: 'ok' | 'no_receipts';
  anchor: DailyMerkleAnchor;
}

export interface InclusionProofResult {
  receipt_id: number;
  payload_sha256: string;
  day_utc: string;
  operator_pubkey: string;
  root_hex: string;
  audit_path: string[];
  leaf_index: number;
  tree_size: number;
}

export class DailyMerkleAnchorService {
  private now: () => number;

  constructor(private readonly deps: DailyMerkleAnchorServiceDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Compute (or fetch existing) daily Merkle root for the given UTC day.
   *  Idempotent — re-invoking for the same day returns the existing anchor. */
  async computeAndPersist(dayUtc: string): Promise<ComputeResult> {
    const existing = await this.deps.repo.findByDayOperator(dayUtc, this.deps.operatorPubkeyHex);
    if (existing) {
      return { status: existing.receipt_count === 0 ? 'no_receipts' : 'ok', anchor: existing };
    }

    const { startSec, endSec } = utcDayBounds(dayUtc);
    const receipts = await this.deps.repo.fetchReceiptsInWindow(startSec, endSec);

    const leaves = receiptsToLeaves(receipts);
    const root = merkleRoot(leaves);

    const anchor = await this.deps.repo.createOrGet({
      day_utc: dayUtc,
      operator_pubkey: this.deps.operatorPubkeyHex,
      root_hex: rootHex(root),
      receipt_count: receipts.length,
      receipt_first_id: receipts[0]?.receipt_id ?? null,
      receipt_last_id: receipts[receipts.length - 1]?.receipt_id ?? null,
      computed_at: this.now(),
    });

    logger.info(
      {
        day_utc: dayUtc,
        operator_pubkey: this.deps.operatorPubkeyHex.slice(0, 12),
        receipt_count: receipts.length,
        root_first8: anchor.root_hex.slice(0, 8),
      },
      'AEPS §8: daily Merkle anchor computed',
    );

    return { status: receipts.length === 0 ? 'no_receipts' : 'ok', anchor };
  }

  /** Build an audit path for a single receipt against the day it was issued. */
  async buildInclusionProof(receiptId: number): Promise<InclusionProofResult | null> {
    // Find the receipt and the day it falls in.
    const receiptRow = await this.deps.repo.findReceiptByPayloadHash('').catch(() => null);
    // We don't have a findById on the anchor repo; we re-derive via the receipt's signed_at.
    // The cleanest path: the caller routes via /api/fulfill/:job_id/evidence first to get
    // the payload_sha256, then calls this with that hash. For receipt_id-based lookup we
    // need a small DB hop:
    const recipt = await this.lookupReceiptById(receiptId);
    if (!recipt) return null;

    const dayUtc = unixSecToUtcDay(recipt.signed_at);
    const anchor = await this.deps.repo.findByDayOperator(dayUtc, this.deps.operatorPubkeyHex);
    if (!anchor) return null;

    const { startSec, endSec } = utcDayBounds(dayUtc);
    const receipts = await this.deps.repo.fetchReceiptsInWindow(startSec, endSec);
    const leaves = receiptsToLeaves(receipts);
    const idx = receipts.findIndex(r => r.receipt_id === receiptId);
    if (idx < 0) return null;

    const proof = inclusionProof(leaves, idx);

    return {
      receipt_id: receiptId,
      payload_sha256: recipt.payload_sha256,
      day_utc: dayUtc,
      operator_pubkey: anchor.operator_pubkey,
      root_hex: anchor.root_hex,
      audit_path: pathHex(proof),
      leaf_index: idx,
      tree_size: receipts.length,
    };
  }

  private async lookupReceiptById(receiptId: number): Promise<{ receipt_id: number; payload_sha256: string; signed_at: number } | null> {
    // Direct query — not worth a method on the repo for this single use.
    const db = (this.deps.repo as unknown as { db: { query: <T>(q: string, params: unknown[]) => Promise<{ rows: T[] }> } }).db;
    const { rows } = await db.query<{
      receipt_id: string | number;
      payload_sha256: string;
      signed_at: string | number;
    }>(
      'SELECT receipt_id, payload_sha256, signed_at FROM evidence_receipts WHERE receipt_id = $1',
      [receiptId],
    );
    if (!rows[0]) return null;
    return {
      receipt_id: Number(rows[0].receipt_id),
      payload_sha256: rows[0].payload_sha256,
      signed_at: Number(rows[0].signed_at),
    };
  }
}

/** Map evidence receipts to Merkle leaves. The leaf is the raw 32-byte SHA-256
 *  of payload_canonical_json (already computed at receipt-issue time). */
export function receiptsToLeaves(receipts: ReadonlyArray<ReceiptForAnchor>): Buffer[] {
  return receipts.map(r => Buffer.from(r.payload_sha256, 'hex'));
}

/** Pure helper exposed for tests: re-run leaf hashing for verifiers. */
export function leafForReceipt(receipt: { payload_sha256: string }): Buffer {
  return leafHash(Buffer.from(receipt.payload_sha256, 'hex'));
}

/** Convert YYYY-MM-DD UTC to [startSec, endSec) unix seconds. */
export function utcDayBounds(dayUtc: string): { startSec: number; endSec: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayUtc)) {
    throw new Error(`utcDayBounds: invalid YYYY-MM-DD: ${dayUtc}`);
  }
  const startMs = Date.UTC(
    Number(dayUtc.slice(0, 4)),
    Number(dayUtc.slice(5, 7)) - 1,
    Number(dayUtc.slice(8, 10)),
  );
  return {
    startSec: Math.floor(startMs / 1000),
    endSec: Math.floor(startMs / 1000) + 86400,
  };
}

/** unix-seconds → YYYY-MM-DD (UTC). */
export function unixSecToUtcDay(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Build the AEPS OP_RETURN payload bytes per whitepaper §8.3 :
 *    "AEPS1" (5 bytes) || operator_pubkey[0..8] (8 bytes) || day_index_le (4 bytes) || root (32 bytes)
 *  Total = 49 bytes. The 4-byte day index is days-since-2026-01-01 (UTC) — small enough
 *  to fit and unambiguous for the next ~11k years.
 *  Returns the raw bytes; caller embeds them in OP_RETURN. */
export function buildOpReturnPayload(
  operatorPubkeyHex: string,
  dayUtc: string,
  rootHexValue: string,
): Buffer {
  const tag = Buffer.from('AEPS1', 'utf8');                  // 5 bytes
  const op8 = Buffer.from(operatorPubkeyHex.slice(0, 16), 'hex'); // 8 bytes
  const dayIndex = utcDayIndex(dayUtc);
  const dayBytes = Buffer.alloc(4);
  dayBytes.writeUInt32LE(dayIndex, 0);
  const rootBytes = Buffer.from(rootHexValue, 'hex');        // 32 bytes
  if (op8.length !== 8) throw new Error('operator_pubkey hex too short');
  if (rootBytes.length !== 32) throw new Error('root hex must be 32 bytes');
  return Buffer.concat([tag, op8, dayBytes, rootBytes]);     // 49 bytes
}

function utcDayIndex(dayUtc: string): number {
  const epochUtc = Date.UTC(2026, 0, 1);                     // 2026-01-01
  const { startSec } = utcDayBounds(dayUtc);
  return Math.floor((startSec * 1000 - epochUtc) / 86400000);
}
