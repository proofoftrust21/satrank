// AEPS §6.3 (2026-05-07) — Multi-hop chain storage.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type ChainState =
  | 'planning'
  | 'locked'
  | 'settling'
  | 'complete'
  | 'aborted';

export type LegState = 'planned' | 'locked' | 'settled' | 'aborted';

export interface MultiHopChain {
  chain_id: string;
  agent_pubkey: string;
  preimage_hash: string;
  preimage_revealed: string | null;
  total_amount_msat: number;
  n_legs: number;
  state: ChainState;
  created_at: number;
  expires_at: number;
  settled_at: number | null;
  aborted_at: number | null;
  abort_reason: string | null;
}

export interface MultiHopLeg {
  leg_id: number;
  chain_id: string;
  leg_index: number;
  endpoint_id: string;
  operator_pubkey: string;
  amount_msat: number;
  request_body_sha256: string;
  state: LegState;
  htlc_ref: string | null;
  fulfilled_response_sha256: string | null;
  locked_at: number | null;
  fulfilled_at: number | null;
  settled_at: number | null;
}

export interface CreateChainInput {
  chain_id: string;
  agent_pubkey: string;
  preimage_hash: string;
  total_amount_msat: number;
  n_legs: number;
  created_at: number;
  expires_at: number;
}

export interface CreateLegInput {
  chain_id: string;
  leg_index: number;
  endpoint_id: string;
  operator_pubkey: string;
  amount_msat: number;
  request_body_sha256: string;
}

export class MultiHopChainRepository {
  constructor(private db: Queryable) {}

  async createChain(input: CreateChainInput): Promise<MultiHopChain> {
    const { rows } = await this.db.query<ChainRow>(
      `INSERT INTO aeps_multihop_chains
        (chain_id, agent_pubkey, preimage_hash, total_amount_msat, n_legs,
         state, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'planning', $6, $7)
       RETURNING *`,
      [
        input.chain_id,
        input.agent_pubkey,
        input.preimage_hash,
        input.total_amount_msat,
        input.n_legs,
        input.created_at,
        input.expires_at,
      ],
    );
    return rowToChain(rows[0]);
  }

  async createLegs(legs: CreateLegInput[]): Promise<MultiHopLeg[]> {
    if (legs.length === 0) return [];
    // Build a multi-row VALUES clause.
    const placeholders: string[] = [];
    const values: (string | number)[] = [];
    legs.forEach((l, i) => {
      const base = i * 6;
      placeholders.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, 'planned')`,
      );
      values.push(
        l.chain_id,
        l.leg_index,
        l.endpoint_id,
        l.operator_pubkey,
        l.amount_msat,
        l.request_body_sha256,
      );
    });
    const sql =
      `INSERT INTO aeps_multihop_chain_legs
        (chain_id, leg_index, endpoint_id, operator_pubkey, amount_msat,
         request_body_sha256, state)
       VALUES ${placeholders.join(', ')}
       RETURNING *`;
    const { rows } = await this.db.query<LegRow>(sql, values);
    return rows.map(rowToLeg);
  }

  async findChain(chainId: string): Promise<MultiHopChain | null> {
    const { rows } = await this.db.query<ChainRow>(
      'SELECT * FROM aeps_multihop_chains WHERE chain_id = $1',
      [chainId],
    );
    return rows[0] ? rowToChain(rows[0]) : null;
  }

  async listLegs(chainId: string): Promise<MultiHopLeg[]> {
    const { rows } = await this.db.query<LegRow>(
      `SELECT * FROM aeps_multihop_chain_legs
       WHERE chain_id = $1
       ORDER BY leg_index ASC`,
      [chainId],
    );
    return rows.map(rowToLeg);
  }

  async updateChainState(
    chainId: string,
    state: ChainState,
    extra: {
      preimage_revealed?: string;
      settled_at?: number;
      aborted_at?: number;
      abort_reason?: string;
    } = {},
  ): Promise<void> {
    const sets: string[] = ['state = $2'];
    const params: (string | number | null)[] = [chainId, state];
    if (extra.preimage_revealed !== undefined) {
      sets.push(`preimage_revealed = $${params.length + 1}`);
      params.push(extra.preimage_revealed);
    }
    if (extra.settled_at !== undefined) {
      sets.push(`settled_at = $${params.length + 1}`);
      params.push(extra.settled_at);
    }
    if (extra.aborted_at !== undefined) {
      sets.push(`aborted_at = $${params.length + 1}`);
      params.push(extra.aborted_at);
    }
    if (extra.abort_reason !== undefined) {
      sets.push(`abort_reason = $${params.length + 1}`);
      params.push(extra.abort_reason);
    }
    await this.db.query(
      `UPDATE aeps_multihop_chains SET ${sets.join(', ')} WHERE chain_id = $1`,
      params,
    );
  }

  async updateLegState(
    chainId: string,
    legIndex: number,
    state: LegState,
    extra: {
      htlc_ref?: string;
      fulfilled_response_sha256?: string;
      locked_at?: number;
      fulfilled_at?: number;
      settled_at?: number;
    } = {},
  ): Promise<void> {
    const sets: string[] = ['state = $3'];
    const params: (string | number | null)[] = [chainId, legIndex, state];
    if (extra.htlc_ref !== undefined) {
      sets.push(`htlc_ref = $${params.length + 1}`);
      params.push(extra.htlc_ref);
    }
    if (extra.fulfilled_response_sha256 !== undefined) {
      sets.push(`fulfilled_response_sha256 = $${params.length + 1}`);
      params.push(extra.fulfilled_response_sha256);
    }
    if (extra.locked_at !== undefined) {
      sets.push(`locked_at = $${params.length + 1}`);
      params.push(extra.locked_at);
    }
    if (extra.fulfilled_at !== undefined) {
      sets.push(`fulfilled_at = $${params.length + 1}`);
      params.push(extra.fulfilled_at);
    }
    if (extra.settled_at !== undefined) {
      sets.push(`settled_at = $${params.length + 1}`);
      params.push(extra.settled_at);
    }
    await this.db.query(
      `UPDATE aeps_multihop_chain_legs
       SET ${sets.join(', ')}
       WHERE chain_id = $1 AND leg_index = $2`,
      params,
    );
  }

  async findExpiredActiveChains(nowSec: number): Promise<MultiHopChain[]> {
    const { rows } = await this.db.query<ChainRow>(
      `SELECT * FROM aeps_multihop_chains
       WHERE state IN ('planning', 'locked', 'settling')
         AND expires_at < $1
       ORDER BY created_at ASC
       LIMIT 100`,
      [nowSec],
    );
    return rows.map(rowToChain);
  }
}

interface ChainRow {
  chain_id: string;
  agent_pubkey: string;
  preimage_hash: string;
  preimage_revealed: string | null;
  total_amount_msat: string | number;
  n_legs: string | number;
  state: string;
  created_at: string | number;
  expires_at: string | number;
  settled_at: string | number | null;
  aborted_at: string | number | null;
  abort_reason: string | null;
}

interface LegRow {
  leg_id: string | number;
  chain_id: string;
  leg_index: string | number;
  endpoint_id: string;
  operator_pubkey: string;
  amount_msat: string | number;
  request_body_sha256: string;
  state: string;
  htlc_ref: string | null;
  fulfilled_response_sha256: string | null;
  locked_at: string | number | null;
  fulfilled_at: string | number | null;
  settled_at: string | number | null;
}

function rowToChain(r: ChainRow): MultiHopChain {
  return {
    chain_id: r.chain_id,
    agent_pubkey: r.agent_pubkey,
    preimage_hash: r.preimage_hash,
    preimage_revealed: r.preimage_revealed,
    total_amount_msat: Number(r.total_amount_msat),
    n_legs: Number(r.n_legs),
    state: r.state as ChainState,
    created_at: Number(r.created_at),
    expires_at: Number(r.expires_at),
    settled_at: r.settled_at !== null ? Number(r.settled_at) : null,
    aborted_at: r.aborted_at !== null ? Number(r.aborted_at) : null,
    abort_reason: r.abort_reason,
  };
}

function rowToLeg(r: LegRow): MultiHopLeg {
  return {
    leg_id: Number(r.leg_id),
    chain_id: r.chain_id,
    leg_index: Number(r.leg_index),
    endpoint_id: r.endpoint_id,
    operator_pubkey: r.operator_pubkey,
    amount_msat: Number(r.amount_msat),
    request_body_sha256: r.request_body_sha256,
    state: r.state as LegState,
    htlc_ref: r.htlc_ref,
    fulfilled_response_sha256: r.fulfilled_response_sha256,
    locked_at: r.locked_at !== null ? Number(r.locked_at) : null,
    fulfilled_at: r.fulfilled_at !== null ? Number(r.fulfilled_at) : null,
    settled_at: r.settled_at !== null ? Number(r.settled_at) : null,
  };
}
