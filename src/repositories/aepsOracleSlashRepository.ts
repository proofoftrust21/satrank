// AEPS §10 (2026-05-08) — Oracle slash intent storage.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type OracleSlashState =
  | 'recorded'
  | 'reserved'
  | 'executed'
  | 'no_bond_found'
  | 'expired';

export interface OracleSlashIntent {
  slash_intent_id: number;
  oracle_pubkey: string;
  equivocation_id: number;
  bond_id: number | null;
  slash_sats: number;
  state: OracleSlashState;
  created_at: number;
  reserved_at: number | null;
  executed_at: number | null;
  payout_disputant_sats: number | null;
  payout_observer_sats: number | null;
  payout_burned_sats: number | null;
}

export interface CreateSlashIntentInput {
  oracle_pubkey: string;
  equivocation_id: number;
  bond_id: number | null;
  slash_sats: number;
  state: OracleSlashState;
  created_at: number;
  reserved_at?: number | null;
}

export class AepsOracleSlashRepository {
  constructor(private db: Queryable) {}

  /** Idempotent on equivocation_id (one intent per equivocation event). */
  async createOrGet(input: CreateSlashIntentInput): Promise<OracleSlashIntent> {
    const { rows } = await this.db.query<OracleSlashRow>(
      `INSERT INTO aeps_oracle_slash_intents
        (oracle_pubkey, equivocation_id, bond_id, slash_sats, state,
         created_at, reserved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (equivocation_id) DO UPDATE
         SET oracle_pubkey = aeps_oracle_slash_intents.oracle_pubkey
       RETURNING *`,
      [
        input.oracle_pubkey,
        input.equivocation_id,
        input.bond_id,
        input.slash_sats,
        input.state,
        input.created_at,
        input.reserved_at ?? null,
      ],
    );
    return rowToSlash(rows[0]);
  }

  async findByEquivocation(equivocationId: number): Promise<OracleSlashIntent | null> {
    const { rows } = await this.db.query<OracleSlashRow>(
      'SELECT * FROM aeps_oracle_slash_intents WHERE equivocation_id = $1',
      [equivocationId],
    );
    return rows[0] ? rowToSlash(rows[0]) : null;
  }

  async listForOracle(oraclePubkey: string, limit = 100): Promise<OracleSlashIntent[]> {
    const { rows } = await this.db.query<OracleSlashRow>(
      `SELECT * FROM aeps_oracle_slash_intents
       WHERE oracle_pubkey = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [oraclePubkey, limit],
    );
    return rows.map(rowToSlash);
  }

  async transitionToReserved(
    slashIntentId: number,
    bondId: number,
    reservedAt: number,
  ): Promise<void> {
    await this.db.query(
      `UPDATE aeps_oracle_slash_intents
       SET state = 'reserved', bond_id = $2, reserved_at = $3
       WHERE slash_intent_id = $1`,
      [slashIntentId, bondId, reservedAt],
    );
  }

  async transitionToExecuted(
    slashIntentId: number,
    executedAt: number,
    payouts: {
      payout_disputant_sats: number;
      payout_observer_sats: number;
      payout_burned_sats: number;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE aeps_oracle_slash_intents
       SET state = 'executed',
           executed_at = $2,
           payout_disputant_sats = $3,
           payout_observer_sats = $4,
           payout_burned_sats = $5
       WHERE slash_intent_id = $1
         AND state = 'reserved'`,
      [
        slashIntentId,
        executedAt,
        payouts.payout_disputant_sats,
        payouts.payout_observer_sats,
        payouts.payout_burned_sats,
      ],
    );
  }

  /** List intents in 'reserved' state whose grace period has elapsed.
   *  Used by the cron to find candidates for execution. */
  async findReservedReady(graceSec: number, nowSec: number): Promise<OracleSlashIntent[]> {
    const { rows } = await this.db.query<OracleSlashRow>(
      `SELECT * FROM aeps_oracle_slash_intents
       WHERE state = 'reserved'
         AND reserved_at IS NOT NULL
         AND reserved_at + $1 <= $2
       ORDER BY reserved_at ASC
       LIMIT 100`,
      [graceSec, nowSec],
    );
    return rows.map(rowToSlash);
  }
}

interface OracleSlashRow {
  slash_intent_id: string | number;
  oracle_pubkey: string;
  equivocation_id: string | number;
  bond_id: string | number | null;
  slash_sats: string | number;
  state: string;
  created_at: string | number;
  reserved_at: string | number | null;
  executed_at: string | number | null;
  payout_disputant_sats: string | number | null;
  payout_observer_sats: string | number | null;
  payout_burned_sats: string | number | null;
}

function rowToSlash(r: OracleSlashRow): OracleSlashIntent {
  return {
    slash_intent_id: Number(r.slash_intent_id),
    oracle_pubkey: r.oracle_pubkey,
    equivocation_id: Number(r.equivocation_id),
    bond_id: r.bond_id !== null ? Number(r.bond_id) : null,
    slash_sats: Number(r.slash_sats),
    state: r.state as OracleSlashState,
    created_at: Number(r.created_at),
    reserved_at: r.reserved_at !== null ? Number(r.reserved_at) : null,
    executed_at: r.executed_at !== null ? Number(r.executed_at) : null,
    payout_disputant_sats: r.payout_disputant_sats !== null ? Number(r.payout_disputant_sats) : null,
    payout_observer_sats: r.payout_observer_sats !== null ? Number(r.payout_observer_sats) : null,
    payout_burned_sats: r.payout_burned_sats !== null ? Number(r.payout_burned_sats) : null,
  };
}
