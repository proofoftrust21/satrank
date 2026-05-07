// AEPS §8 (2026-05-07) — Daily Merkle anchor storage.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export interface DailyMerkleAnchor {
  anchor_id: number;
  day_utc: string;            // YYYY-MM-DD
  operator_pubkey: string;
  root_hex: string;
  receipt_count: number;
  receipt_first_id: number | null;
  receipt_last_id: number | null;
  l1_txid: string | null;
  l1_block_height: number | null;
  l1_op_return_hex: string | null;
  l1_broadcast_at: number | null;
  nostr_event_id: string | null;
  nostr_published_at: number | null;
  computed_at: number;
}

export interface CreateAnchorInput {
  day_utc: string;
  operator_pubkey: string;
  root_hex: string;
  receipt_count: number;
  receipt_first_id?: number | null;
  receipt_last_id?: number | null;
  computed_at: number;
}

export interface ReceiptForAnchor {
  receipt_id: number;
  payload_sha256: string;
  signed_at: number;
}

export class DailyMerkleAnchorRepository {
  constructor(private db: Queryable) {}

  /** Idempotent: one anchor per (day_utc, operator_pubkey). Returns the row. */
  async createOrGet(input: CreateAnchorInput): Promise<DailyMerkleAnchor> {
    const { rows } = await this.db.query<DailyMerkleAnchorRow>(
      `INSERT INTO daily_merkle_anchors
        (day_utc, operator_pubkey, root_hex, receipt_count,
         receipt_first_id, receipt_last_id, computed_at)
       VALUES ($1::date, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (day_utc, operator_pubkey) DO UPDATE
         SET day_utc = daily_merkle_anchors.day_utc
       RETURNING *`,
      [
        input.day_utc,
        input.operator_pubkey,
        input.root_hex,
        input.receipt_count,
        input.receipt_first_id ?? null,
        input.receipt_last_id ?? null,
        input.computed_at,
      ],
    );
    return rowToAnchor(rows[0]);
  }

  async findByDayOperator(
    dayUtc: string,
    operatorPubkey: string,
  ): Promise<DailyMerkleAnchor | null> {
    const { rows } = await this.db.query<DailyMerkleAnchorRow>(
      `SELECT * FROM daily_merkle_anchors
       WHERE day_utc = $1::date AND operator_pubkey = $2`,
      [dayUtc, operatorPubkey],
    );
    return rows[0] ? rowToAnchor(rows[0]) : null;
  }

  async listRecent(operatorPubkey: string, limit = 30): Promise<DailyMerkleAnchor[]> {
    const { rows } = await this.db.query<DailyMerkleAnchorRow>(
      `SELECT * FROM daily_merkle_anchors
       WHERE operator_pubkey = $1
       ORDER BY day_utc DESC
       LIMIT $2`,
      [operatorPubkey, limit],
    );
    return rows.map(rowToAnchor);
  }

  /** Update L1 broadcast outcome (txid, block, op_return payload). */
  async recordL1Broadcast(
    anchorId: number,
    update: {
      l1_txid: string;
      l1_op_return_hex: string;
      l1_broadcast_at: number;
      l1_block_height?: number | null;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE daily_merkle_anchors
       SET l1_txid = $2,
           l1_op_return_hex = $3,
           l1_broadcast_at = $4,
           l1_block_height = COALESCE($5, l1_block_height)
       WHERE anchor_id = $1`,
      [anchorId, update.l1_txid, update.l1_op_return_hex, update.l1_broadcast_at, update.l1_block_height ?? null],
    );
  }

  async recordNostrPublish(
    anchorId: number,
    nostrEventId: string,
    publishedAt: number,
  ): Promise<void> {
    await this.db.query(
      `UPDATE daily_merkle_anchors
       SET nostr_event_id = $2,
           nostr_published_at = $3
       WHERE anchor_id = $1`,
      [anchorId, nostrEventId, publishedAt],
    );
  }

  /** Fetch evidence receipts whose signed_at falls in [startSec, endSec).
   *  Returns ordered by receipt_id ASC. Used by DailyMerkleAnchorService to
   *  build the deterministic leaf order. */
  async fetchReceiptsInWindow(
    startSec: number,
    endSec: number,
  ): Promise<ReceiptForAnchor[]> {
    const { rows } = await this.db.query<{
      receipt_id: string | number;
      payload_sha256: string;
      signed_at: string | number;
    }>(
      `SELECT receipt_id, payload_sha256, signed_at
       FROM evidence_receipts
       WHERE signed_at >= $1 AND signed_at < $2
       ORDER BY receipt_id ASC`,
      [startSec, endSec],
    );
    return rows.map(r => ({
      receipt_id: Number(r.receipt_id),
      payload_sha256: r.payload_sha256,
      signed_at: Number(r.signed_at),
    }));
  }

  /** Look up a single receipt by its payload_sha256 (used by inclusion-proof
   *  endpoint when the caller supplies the hash but not the receipt_id). */
  async findReceiptByPayloadHash(
    payloadSha256: string,
  ): Promise<{ receipt_id: number; signed_at: number } | null> {
    const { rows } = await this.db.query<{ receipt_id: string | number; signed_at: string | number }>(
      `SELECT receipt_id, signed_at FROM evidence_receipts
       WHERE payload_sha256 = $1
       LIMIT 1`,
      [payloadSha256],
    );
    if (!rows[0]) return null;
    return { receipt_id: Number(rows[0].receipt_id), signed_at: Number(rows[0].signed_at) };
  }
}

interface DailyMerkleAnchorRow {
  anchor_id: string | number;
  day_utc: string | Date;
  operator_pubkey: string;
  root_hex: string;
  receipt_count: string | number;
  receipt_first_id: string | number | null;
  receipt_last_id: string | number | null;
  l1_txid: string | null;
  l1_block_height: string | number | null;
  l1_op_return_hex: string | null;
  l1_broadcast_at: string | number | null;
  nostr_event_id: string | null;
  nostr_published_at: string | number | null;
  computed_at: string | number;
}

function dayOnlyUtc(d: string | Date): string {
  if (typeof d === 'string') return d.slice(0, 10);
  // pg's DATE → JS Date represents midnight in local timezone. Format
  // explicitly via UTC components so the returned string matches the
  // stored DATE without timezone shift.
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  // For DATE columns, pg returns a Date set to midnight LOCAL ; we need
  // the LOCAL-date components, not UTC, because YYYY-MM-DD has no
  // timezone meaning here — it's a calendar date label.
  const yLocal = d.getFullYear().toString().padStart(4, '0');
  const mLocal = (d.getMonth() + 1).toString().padStart(2, '0');
  const dLocal = d.getDate().toString().padStart(2, '0');
  // Prefer the local-date components since pg stores DATE without TZ
  // and creates Date(YYYY, MM, DD) on the JS side at LOCAL midnight.
  void yyyy; void mm; void dd;  // kept for future UTC-source variants
  return `${yLocal}-${mLocal}-${dLocal}`;
}

function rowToAnchor(r: DailyMerkleAnchorRow): DailyMerkleAnchor {
  return {
    anchor_id: Number(r.anchor_id),
    day_utc: dayOnlyUtc(r.day_utc),
    operator_pubkey: r.operator_pubkey,
    root_hex: r.root_hex,
    receipt_count: Number(r.receipt_count),
    receipt_first_id: r.receipt_first_id !== null ? Number(r.receipt_first_id) : null,
    receipt_last_id: r.receipt_last_id !== null ? Number(r.receipt_last_id) : null,
    l1_txid: r.l1_txid,
    l1_block_height: r.l1_block_height !== null ? Number(r.l1_block_height) : null,
    l1_op_return_hex: r.l1_op_return_hex,
    l1_broadcast_at: r.l1_broadcast_at !== null ? Number(r.l1_broadcast_at) : null,
    nostr_event_id: r.nostr_event_id,
    nostr_published_at: r.nostr_published_at !== null ? Number(r.nostr_published_at) : null,
    computed_at: Number(r.computed_at),
  };
}
