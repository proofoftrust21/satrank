// Phase 11B.1 (2026-05-04) — Agent bond storage layer.
//
// Symmetric to operator_bonds (Phase 7.2). One row per (agent_pubkey,
// bond_payment_hash). Agents deposit sats via Lightning hold-invoice ;
// SatRank holds the deposit until releasable_at cooldown elapses or
// AgentSlashingEngine (Phase 11B.3) slashes for validated abuse.
//
// Per autonomy audit 2026-05-04 (lens L2 + L6) — closes the Sybil-via-
// free-pubkey-generation gap and gives autonomous agents an explicit
// stake-based reputation signal that operators can rely on.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type AgentBondState = 'active' | 'frozen' | 'released';

export interface AgentBond {
  bond_id: number;
  agent_pubkey: string;
  bond_payment_hash: string;
  bond_committed_sats: number;
  bond_slashed_sats: number;
  bond_pending_sats: number;
  min_floor_sats: number;
  state: AgentBondState;
  created_at: number;
  releasable_at: number;
  released_at: number | null;
  slashed_total_at: number | null;
}

export interface CreateAgentBondInput {
  agent_pubkey: string;
  bond_payment_hash: string;
  bond_committed_sats: number;
  min_floor_sats?: number;
  releasable_at: number;
  created_at: number;
}

export interface AgentBondPendingDeposit {
  pending_id: number;
  agent_pubkey: string;
  payment_hash: string;
  payment_request: string;
  amount_sats: number;
  created_at: number;
  expires_at: number;
  settled_at: number | null;
}

export class AgentBondRepository {
  constructor(private db: Queryable) {}

  async create(input: CreateAgentBondInput): Promise<AgentBond> {
    const { rows } = await this.db.query<AgentBondRow>(
      `INSERT INTO agent_bonds
        (agent_pubkey, bond_payment_hash, bond_committed_sats, min_floor_sats,
         created_at, releasable_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.agent_pubkey,
        input.bond_payment_hash,
        input.bond_committed_sats,
        input.min_floor_sats ?? 100,
        input.created_at,
        input.releasable_at,
      ],
    );
    return rowToBond(rows[0]);
  }

  async findById(bondId: number): Promise<AgentBond | null> {
    const { rows } = await this.db.query<AgentBondRow>(
      'SELECT * FROM agent_bonds WHERE bond_id = $1',
      [bondId],
    );
    return rows[0] ? rowToBond(rows[0]) : null;
  }

  async findActiveByAgent(agentPubkey: string): Promise<AgentBond[]> {
    const { rows } = await this.db.query<AgentBondRow>(
      `SELECT * FROM agent_bonds
       WHERE agent_pubkey = $1 AND state = 'active'
       ORDER BY created_at DESC`,
      [agentPubkey],
    );
    return rows.map(rowToBond);
  }

  /** Sum of (committed - slashed - pending) across active bonds for an
   *  agent. Used by the rate-limit + credit-line tier gate : an agent's
   *  available bond determines bronze/silver/gold tier (Phase 11B.2). */
  async availableForAgent(agentPubkey: string): Promise<number> {
    const { rows } = await this.db.query<{ available: string | null }>(
      `SELECT COALESCE(SUM(bond_committed_sats - bond_slashed_sats - bond_pending_sats), 0)::text AS available
         FROM agent_bonds
        WHERE agent_pubkey = $1 AND state = 'active'`,
      [agentPubkey],
    );
    return Number(rows[0]?.available ?? 0);
  }

  async reservePending(bondId: number, sats: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE agent_bonds
          SET bond_pending_sats = bond_pending_sats + $2
        WHERE bond_id = $1
          AND state = 'active'
          AND bond_committed_sats - bond_slashed_sats - bond_pending_sats >= $2`,
      [bondId, sats],
    );
    return (rowCount ?? 0) === 1;
  }

  async releasePending(bondId: number, sats: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE agent_bonds
          SET bond_pending_sats = GREATEST(0, bond_pending_sats - $2)
        WHERE bond_id = $1
          AND state IN ('active', 'frozen')`,
      [bondId, sats],
    );
    return (rowCount ?? 0) === 1;
  }

  async commitSlash(bondId: number, sats: number, settledAt: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE agent_bonds
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

  async setState(bondId: number, newState: AgentBondState): Promise<boolean> {
    const allowedFrom: Record<AgentBondState, AgentBondState[]> = {
      active: ['frozen', 'released'],
      frozen: ['active', 'released'],
      released: [],
    };
    const fromStates = (Object.entries(allowedFrom) as [AgentBondState, AgentBondState[]][])
      .filter(([, targets]) => targets.includes(newState))
      .map(([from]) => from);
    if (fromStates.length === 0) return false;
    const { rowCount } = await this.db.query(
      `UPDATE agent_bonds SET state = $2 WHERE bond_id = $1 AND state = ANY($3::text[])`,
      [bondId, newState, fromStates],
    );
    return (rowCount ?? 0) === 1;
  }

  async findBelowFloor(): Promise<AgentBond[]> {
    const { rows } = await this.db.query<AgentBondRow>(
      `SELECT * FROM agent_bonds
       WHERE state = 'active'
         AND bond_committed_sats - bond_slashed_sats - bond_pending_sats < min_floor_sats
       ORDER BY agent_pubkey`,
    );
    return rows.map(rowToBond);
  }

  async findReleasable(nowSec: number): Promise<AgentBond[]> {
    const { rows } = await this.db.query<AgentBondRow>(
      `SELECT * FROM agent_bonds
       WHERE state = 'active'
         AND bond_pending_sats = 0
         AND releasable_at <= $1
       ORDER BY releasable_at ASC
       LIMIT 50`,
      [nowSec],
    );
    return rows.map(rowToBond);
  }

  // Pending deposit lifecycle ---------------------------------------------

  async createPendingDeposit(input: {
    agent_pubkey: string;
    payment_hash: string;
    payment_request: string;
    amount_sats: number;
    created_at: number;
    expires_at: number;
  }): Promise<AgentBondPendingDeposit> {
    const { rows } = await this.db.query<PendingDepositRow>(
      `INSERT INTO agent_bond_pending_deposits
        (agent_pubkey, payment_hash, payment_request, amount_sats,
         created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.agent_pubkey,
        input.payment_hash,
        input.payment_request,
        input.amount_sats,
        input.created_at,
        input.expires_at,
      ],
    );
    return rowToPending(rows[0]);
  }

  async findPendingByPaymentHash(paymentHash: string): Promise<AgentBondPendingDeposit | null> {
    const { rows } = await this.db.query<PendingDepositRow>(
      'SELECT * FROM agent_bond_pending_deposits WHERE payment_hash = $1',
      [paymentHash],
    );
    return rows[0] ? rowToPending(rows[0]) : null;
  }

  async settlePendingDeposit(paymentHash: string, settledAt: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE agent_bond_pending_deposits
          SET settled_at = $2
        WHERE payment_hash = $1 AND settled_at IS NULL`,
      [paymentHash, settledAt],
    );
    return (rowCount ?? 0) === 1;
  }
}

interface AgentBondRow {
  bond_id: string | number;
  agent_pubkey: string;
  bond_payment_hash: string;
  bond_committed_sats: string | number;
  bond_slashed_sats: string | number;
  bond_pending_sats: string | number;
  min_floor_sats: string | number;
  state: AgentBondState;
  created_at: string | number;
  releasable_at: string | number;
  released_at: string | number | null;
  slashed_total_at: string | number | null;
}

interface PendingDepositRow {
  pending_id: string | number;
  agent_pubkey: string;
  payment_hash: string;
  payment_request: string;
  amount_sats: string | number;
  created_at: string | number;
  expires_at: string | number;
  settled_at: string | number | null;
}

function rowToBond(r: AgentBondRow): AgentBond {
  return {
    bond_id: Number(r.bond_id),
    agent_pubkey: r.agent_pubkey,
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

function rowToPending(r: PendingDepositRow): AgentBondPendingDeposit {
  return {
    pending_id: Number(r.pending_id),
    agent_pubkey: r.agent_pubkey,
    payment_hash: r.payment_hash,
    payment_request: r.payment_request,
    amount_sats: Number(r.amount_sats),
    created_at: Number(r.created_at),
    expires_at: Number(r.expires_at),
    settled_at: r.settled_at != null ? Number(r.settled_at) : null,
  };
}
