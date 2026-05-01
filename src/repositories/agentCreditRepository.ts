// Phase 9.4 (2026-05-01) — Agent credit line storage.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export interface AgentCredits {
  agent_pubkey: string;
  accumulated_sats: number;
  borrowed_sats: number;
  last_event_at: number;
  created_at: number;
}

export class AgentCreditRepository {
  constructor(private db: Queryable) {}

  async find(agentPubkey: string): Promise<AgentCredits | null> {
    const { rows } = await this.db.query<AgentCreditRow>(
      'SELECT * FROM agent_credits WHERE agent_pubkey = $1',
      [agentPubkey],
    );
    return rows[0] ? rowTo(rows[0]) : null;
  }

  /** Atomic +1 reputation sat on a successful delivery. Idempotency is the
   *  caller's responsibility (this repo bumps unconditionally). */
  async incrementOnSuccess(agentPubkey: string, nowSec: number): Promise<void> {
    await this.db.query(
      `INSERT INTO agent_credits (agent_pubkey, accumulated_sats, borrowed_sats, last_event_at, created_at)
       VALUES ($1, 1, 0, $2, $2)
       ON CONFLICT (agent_pubkey) DO UPDATE
         SET accumulated_sats = agent_credits.accumulated_sats + 1,
             last_event_at = $2`,
      [agentPubkey, nowSec],
    );
  }

  /** Borrow up to `amount` sats against the agent's credit line. Atomic via
   *  CHECK constraint (borrowed ≤ accumulated). Returns true iff the loan
   *  was approved (= borrowed_sats incremented), false on insufficient
   *  reputation. */
  async borrow(agentPubkey: string, amount: number, nowSec: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE agent_credits
          SET borrowed_sats = borrowed_sats + $2,
              last_event_at = $3
        WHERE agent_pubkey = $1
          AND borrowed_sats + $2 <= accumulated_sats`,
      [agentPubkey, amount, nowSec],
    );
    return (rowCount ?? 0) === 1;
  }

  /** Repay `amount` sats of the outstanding borrow. Used when the agent
   *  earns more credits or directly tops up their token_balance. Atomic. */
  async repay(agentPubkey: string, amount: number, nowSec: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE agent_credits
          SET borrowed_sats = GREATEST(0, borrowed_sats - $2),
              last_event_at = $3
        WHERE agent_pubkey = $1`,
      [agentPubkey, amount, nowSec],
    );
    return (rowCount ?? 0) === 1;
  }

  async availableCredit(agentPubkey: string): Promise<number> {
    const r = await this.find(agentPubkey);
    if (!r) return 0;
    return Math.max(0, r.accumulated_sats - r.borrowed_sats);
  }
}

interface AgentCreditRow {
  agent_pubkey: string;
  accumulated_sats: string | number;
  borrowed_sats: string | number;
  last_event_at: string | number;
  created_at: string | number;
}

function rowTo(r: AgentCreditRow): AgentCredits {
  return {
    agent_pubkey: r.agent_pubkey,
    accumulated_sats: Number(r.accumulated_sats),
    borrowed_sats: Number(r.borrowed_sats),
    last_event_at: Number(r.last_event_at),
    created_at: Number(r.created_at),
  };
}
