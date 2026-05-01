// Phase 7.2 (2026-05-01) — Operator bond storage layer.
//
// One row per (operator_pubkey, bond_payment_hash). Operators deposit sats
// via a Lightning hold-invoice and SatRank holds the deposit until the
// release_at cooldown elapses or the ClaimEngine slashes it on misdelivery.
// Slashing is application-level (ClaimEngine) ; this repository only
// encodes the storage model + atomic transitions (pending → slashed,
// available reservation, release on terminal state).
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type OperatorBondState = 'active' | 'frozen' | 'released';

export interface OperatorBond {
  bond_id: number;
  operator_pubkey: string;
  bond_payment_hash: string;
  bond_committed_sats: number;
  bond_slashed_sats: number;
  bond_pending_sats: number;
  min_floor_sats: number;
  state: OperatorBondState;
  created_at: number;
  releasable_at: number;
  released_at: number | null;
  slashed_total_at: number | null;
}

export interface CreateBondInput {
  operator_pubkey: string;
  bond_payment_hash: string;
  bond_committed_sats: number;
  min_floor_sats?: number;
  releasable_at: number;
  created_at: number;
}

export class OperatorBondRepository {
  constructor(private db: Queryable) {}

  async create(input: CreateBondInput): Promise<OperatorBond> {
    const { rows } = await this.db.query<OperatorBondRow>(
      `INSERT INTO operator_bonds
        (operator_pubkey, bond_payment_hash, bond_committed_sats, min_floor_sats,
         created_at, releasable_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.operator_pubkey,
        input.bond_payment_hash,
        input.bond_committed_sats,
        input.min_floor_sats ?? 100,
        input.created_at,
        input.releasable_at,
      ],
    );
    return rowToBond(rows[0]);
  }

  async findById(bondId: number): Promise<OperatorBond | null> {
    const { rows } = await this.db.query<OperatorBondRow>(
      'SELECT * FROM operator_bonds WHERE bond_id = $1',
      [bondId],
    );
    return rows[0] ? rowToBond(rows[0]) : null;
  }

  async findActiveByOperator(operatorPubkey: string): Promise<OperatorBond[]> {
    const { rows } = await this.db.query<OperatorBondRow>(
      `SELECT * FROM operator_bonds
       WHERE operator_pubkey = $1 AND state = 'active'
       ORDER BY created_at DESC`,
      [operatorPubkey],
    );
    return rows.map(rowToBond);
  }

  /** Sum of (committed - slashed - pending) across all active bonds for an
   *  operator. Used by the listing-eligibility check : an operator with
   *  total available below `min_floor_sats` should be auto-delisted from
   *  the catalogue ranking until top-up. */
  async availableForOperator(operatorPubkey: string): Promise<number> {
    const { rows } = await this.db.query<{ available: string | null }>(
      `SELECT COALESCE(SUM(bond_committed_sats - bond_slashed_sats - bond_pending_sats), 0)::text AS available
         FROM operator_bonds
        WHERE operator_pubkey = $1 AND state = 'active'`,
      [operatorPubkey],
    );
    return Number(rows[0]?.available ?? 0);
  }

  /** Reserve sats for an in-flight claim. Atomic : refuses if available drops
   *  below 0. Used by ClaimEngine when it opens a `pending` claim. */
  async reservePending(bondId: number, sats: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE operator_bonds
          SET bond_pending_sats = bond_pending_sats + $2
        WHERE bond_id = $1
          AND state = 'active'
          AND bond_committed_sats - bond_slashed_sats - bond_pending_sats >= $2`,
      [bondId, sats],
    );
    return (rowCount ?? 0) === 1;
  }

  /** Release a previously-reserved pending without slashing (claim rejected
   *  or disputed-upheld-for-operator). */
  async releasePending(bondId: number, sats: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE operator_bonds
          SET bond_pending_sats = GREATEST(0, bond_pending_sats - $2)
        WHERE bond_id = $1`,
      [bondId, sats],
    );
    return (rowCount ?? 0) === 1;
  }

  /** Convert reserved pending into permanent slashed (claim paid).
   *  Atomic : pending must already be ≥ sats. */
  async commitSlash(bondId: number, sats: number, settledAt: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE operator_bonds
          SET bond_slashed_sats = bond_slashed_sats + $2,
              bond_pending_sats = bond_pending_sats - $2,
              slashed_total_at = CASE
                WHEN bond_slashed_sats + $2 >= bond_committed_sats THEN $3
                ELSE slashed_total_at
              END
        WHERE bond_id = $1
          AND bond_pending_sats >= $2`,
      [bondId, sats, settledAt],
    );
    return (rowCount ?? 0) === 1;
  }

  async setState(bondId: number, state: OperatorBondState): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'UPDATE operator_bonds SET state = $2 WHERE bond_id = $1',
      [bondId, state],
    );
    return (rowCount ?? 0) === 1;
  }

  /** Cron-side query : bonds whose available has dropped below floor.
   *  Catalogue ranking should de-emphasize these operators. */
  async findBelowFloor(): Promise<OperatorBond[]> {
    const { rows } = await this.db.query<OperatorBondRow>(
      `SELECT * FROM operator_bonds
       WHERE state = 'active'
         AND bond_committed_sats - bond_slashed_sats - bond_pending_sats < min_floor_sats
       ORDER BY operator_pubkey`,
    );
    return rows.map(rowToBond);
  }

  /** Cron-side query : bonds eligible for release (cooldown elapsed + no
   *  pending claims). Operators receive their committed-minus-slashed back. */
  async findReleasable(nowSec: number): Promise<OperatorBond[]> {
    const { rows } = await this.db.query<OperatorBondRow>(
      `SELECT * FROM operator_bonds
       WHERE state = 'active'
         AND bond_pending_sats = 0
         AND releasable_at <= $1
       ORDER BY releasable_at ASC
       LIMIT 50`,
      [nowSec],
    );
    return rows.map(rowToBond);
  }
}

interface OperatorBondRow {
  bond_id: string | number;
  operator_pubkey: string;
  bond_payment_hash: string;
  bond_committed_sats: string | number;
  bond_slashed_sats: string | number;
  bond_pending_sats: string | number;
  min_floor_sats: string | number;
  state: OperatorBondState;
  created_at: string | number;
  releasable_at: string | number;
  released_at: string | number | null;
  slashed_total_at: string | number | null;
}

function rowToBond(r: OperatorBondRow): OperatorBond {
  return {
    bond_id: Number(r.bond_id),
    operator_pubkey: r.operator_pubkey,
    bond_payment_hash: r.bond_payment_hash,
    bond_committed_sats: Number(r.bond_committed_sats),
    bond_slashed_sats: Number(r.bond_slashed_sats),
    bond_pending_sats: Number(r.bond_pending_sats),
    min_floor_sats: Number(r.min_floor_sats),
    state: r.state,
    created_at: Number(r.created_at),
    releasable_at: Number(r.releasable_at),
    released_at: r.released_at != null ? Number(r.released_at) : null,
    slashed_total_at: r.slashed_total_at != null ? Number(r.slashed_total_at) : null,
  };
}
