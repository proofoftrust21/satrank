// Phase 11B.1 (2026-05-04) — Agent bond posting flow.
//
// Mirror of OperatorBondService (Phase 7.2), oriented at autonomous agents
// who post a refundable stake to gain higher rate-limit / credit-line
// allowances and to make Sybil generation expensive. AgentSlashingEngine
// (Phase 11B.3) consumes this surface to slash on validated abuse.
//
// V1 simplifications mirror OperatorBondService :
//   - One active bond per agent at a time. Top-ups create sibling rows
//     and aggregate via availableForAgent().
//   - Release flow : agent calls requestRelease() ; bond → 'frozen' ;
//     cron releases when no pending slashes AND releasable_at elapsed.
//   - Cooldown default 14 days, configurable per deposit.
//   - LND hold-invoice issued at deposit time ; settlement happens via
//     external watcher (for v1, callers must invoke settleDeposit()).
import { logger } from '../logger';
import type { LndHoldInvoiceService } from './lndHoldInvoiceService';
import type {
  AgentBondRepository,
  AgentBond,
} from '../repositories/agentBondRepository';

const DEFAULT_COOLDOWN_SEC = 14 * 24 * 3600;
const MIN_BOND_SATS = 1000;     // refuse trivially small bonds (admin floor)
const MAX_BOND_SATS = 10_000_000;

export interface AgentBondDepositRequest {
  agent_pubkey: string;
  bond_sats: number;
  min_floor_sats?: number;
  cooldown_sec?: number;
  memo?: string;
}

export type AgentBondDepositResult =
  | {
      status: 'invoice_issued';
      bond_id: number;
      payment_request: string;
      payment_hash: string;
      expires_at: number;
    }
  | { status: 'lnd_unavailable'; reason: string }
  | { status: 'invalid_request'; reason: string };

export interface AgentBondServiceDeps {
  bondRepo: AgentBondRepository;
  holdInvoiceService?: LndHoldInvoiceService;
  now?: () => number;
}

export class AgentBondService {
  private now: () => number;

  constructor(private readonly deps: AgentBondServiceDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async createDeposit(req: AgentBondDepositRequest): Promise<AgentBondDepositResult> {
    if (req.bond_sats < MIN_BOND_SATS || req.bond_sats > MAX_BOND_SATS) {
      return {
        status: 'invalid_request',
        reason: `bond_sats must be in [${MIN_BOND_SATS}, ${MAX_BOND_SATS}]`,
      };
    }
    const minFloor = req.min_floor_sats ?? 100;
    if (minFloor > req.bond_sats / 2) {
      return {
        status: 'invalid_request',
        reason: 'min_floor_sats cannot exceed half the bond_sats',
      };
    }
    const cooldownSec = req.cooldown_sec ?? DEFAULT_COOLDOWN_SEC;
    if (cooldownSec < 86400 || cooldownSec > 90 * 86400) {
      return {
        status: 'invalid_request',
        reason: 'cooldown_sec must be in [1d, 90d]',
      };
    }

    if (!this.deps.holdInvoiceService || !this.deps.holdInvoiceService.isAvailable()) {
      return { status: 'lnd_unavailable', reason: 'LND hold-invoice service not configured' };
    }

    const expirySec = 3600;
    let invoice;
    try {
      invoice = await this.deps.holdInvoiceService.addHoldInvoice({
        valueSat: req.bond_sats,
        memo: req.memo ?? `SatRank agent bond ${req.agent_pubkey.slice(0, 8)}`,
        expirySec,
      });
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'AgentBondService: addHoldInvoice failed',
      );
      return { status: 'lnd_unavailable', reason: 'addHoldInvoice failed — see server logs' };
    }

    const nowSec = this.now();
    const bond = await this.deps.bondRepo.create({
      agent_pubkey: req.agent_pubkey,
      bond_payment_hash: invoice.payment_hash,
      bond_committed_sats: req.bond_sats,
      min_floor_sats: minFloor,
      releasable_at: nowSec + cooldownSec,
      created_at: nowSec,
    });
    return {
      status: 'invoice_issued',
      bond_id: bond.bond_id,
      payment_request: invoice.payment_request,
      payment_hash: invoice.payment_hash,
      expires_at: nowSec + expirySec,
    };
  }

  /** Agent-side : freeze a bond. Used when the agent wants to pause
   *  consumption without yet requesting full withdraw. */
  async freeze(bondId: number, agentPubkey: string): Promise<boolean> {
    const bond = await this.deps.bondRepo.findById(bondId);
    if (!bond) return false;
    if (bond.agent_pubkey !== agentPubkey) return false;
    if (bond.state !== 'active') return false;
    return this.deps.bondRepo.setState(bondId, 'frozen');
  }

  /** Cron : agents with available bond < min_floor are bronze-tier (no
   *  credit, low rate-limit) and should be flagged in the operator-side
   *  view of the Sybil-defence funnel. */
  async findUnderfundedAgents(): Promise<string[]> {
    const bonds = await this.deps.bondRepo.findBelowFloor();
    const seen = new Set<string>();
    for (const b of bonds) seen.add(b.agent_pubkey);
    return [...seen];
  }

  /** Cron : bonds eligible for release. Outbound payment to the agent's
   *  refund_bolt11 happens separately (mirrors OperatorBondService.findReleasable). */
  async findReleasable(): Promise<AgentBond[]> {
    return this.deps.bondRepo.findReleasable(this.now());
  }

  async availableForAgent(agentPubkey: string): Promise<number> {
    return this.deps.bondRepo.availableForAgent(agentPubkey);
  }

  async listForAgent(agentPubkey: string): Promise<AgentBond[]> {
    return this.deps.bondRepo.findActiveByAgent(agentPubkey);
  }
}
