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
import { InvoiceAlreadyCanceledError } from './lndHoldInvoiceService';
import type {
  AgentBondRepository,
  AgentBond,
  AgentBondPendingDeposit,
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
    // Phase 11B.6 — bond row is created LOCKED (bond_pending_sats =
    // bond_committed_sats) so available_sats=0 until the settlement
    // watcher unlocks it. Phantom bonds (deposit invoice never paid)
    // therefore grant ZERO tier benefit. Pending_deposits row holds the
    // preimage the watcher needs to call /v2/invoices/settle on LND.
    const bond = await this.deps.bondRepo.create({
      agent_pubkey: req.agent_pubkey,
      bond_payment_hash: invoice.payment_hash,
      bond_committed_sats: req.bond_sats,
      bond_pending_sats: req.bond_sats,
      min_floor_sats: minFloor,
      releasable_at: nowSec + cooldownSec,
      created_at: nowSec,
    });
    await this.deps.bondRepo.createPendingDeposit({
      agent_pubkey: req.agent_pubkey,
      payment_hash: invoice.payment_hash,
      payment_request: invoice.payment_request,
      amount_sats: req.bond_sats,
      created_at: nowSec,
      expires_at: nowSec + expirySec,
      preimage_hex: invoice.preimage,
    });
    return {
      status: 'invoice_issued',
      bond_id: bond.bond_id,
      payment_request: invoice.payment_request,
      payment_hash: invoice.payment_hash,
      expires_at: nowSec + expirySec,
    };
  }

  /** Phase 11B.6 — settlement watcher tick. For each unsettled pending
   *  deposit, looks up the LND invoice state. ACCEPTED → settle the
   *  preimage and unlock the bond ; CANCELED/EXPIRED → leave the bond
   *  locked (the `released_at` cooldown will eventually mark it dead) and
   *  flag the pending_deposit settled with the failure reason. */
  async runSettlementCycle(): Promise<{ unlocked: number; failed: number; skipped: number }> {
    if (!this.deps.holdInvoiceService || !this.deps.holdInvoiceService.isAvailable()) {
      return { unlocked: 0, failed: 0, skipped: 0 };
    }
    const lnd = this.deps.holdInvoiceService;
    const pending = await this.deps.bondRepo.findUnsettledPendingDeposits(50);
    let unlocked = 0;
    let failed = 0;
    let skipped = 0;
    for (const dep of pending) {
      const outcome = await this.settleOneDeposit(dep, lnd);
      if (outcome === 'unlocked') unlocked += 1;
      else if (outcome === 'failed') failed += 1;
      else skipped += 1;
    }
    if (unlocked + failed > 0) {
      logger.info(
        { unlocked, failed, skipped, evaluated: pending.length },
        'AgentBondService: settlement cycle complete',
      );
    }
    return { unlocked, failed, skipped };
  }

  /** Single-deposit transition. Visible for testing. */
  async settleOneDeposit(
    dep: AgentBondPendingDeposit,
    lnd: LndHoldInvoiceService,
  ): Promise<'unlocked' | 'failed' | 'skipped'> {
    const nowSec = this.now();
    let state: 'OPEN' | 'ACCEPTED' | 'SETTLED' | 'CANCELED' | 'EXPIRED' | 'UNKNOWN';
    try {
      state = (await lnd.lookupState(dep.payment_hash)).state;
    } catch (err) {
      logger.info(
        { payment_hash_first8: dep.payment_hash.slice(0, 8), error: err instanceof Error ? err.message : String(err) },
        'AgentBondService: lookupState failed, will retry next tick',
      );
      return 'skipped';
    }
    // ACCEPTED → claim the HTLC by revealing the preimage.
    if (state === 'ACCEPTED') {
      if (!dep.preimage_hex) {
        // Legacy v71 row without preimage — can't settle, mark failed.
        await this.deps.bondRepo.settlePendingDeposit(dep.payment_hash, nowSec);
        return 'failed';
      }
      try {
        await lnd.settle(dep.preimage_hex);
      } catch (err) {
        if (err instanceof InvoiceAlreadyCanceledError) {
          await this.deps.bondRepo.settlePendingDeposit(dep.payment_hash, nowSec);
          return 'failed';
        }
        logger.warn(
          { payment_hash_first8: dep.payment_hash.slice(0, 8), error: err instanceof Error ? err.message : String(err) },
          'AgentBondService: settle failed, will retry next tick',
        );
        return 'skipped';
      }
      // Settle on LND succeeded → release the bond_pending_sats lock so
      // the bond becomes available for tier benefits.
      const bond = await this.deps.bondRepo.findByPaymentHash(dep.payment_hash);
      if (bond) {
        await this.deps.bondRepo.releasePending(bond.bond_id, dep.amount_sats);
      }
      await this.deps.bondRepo.settlePendingDeposit(dep.payment_hash, nowSec);
      logger.info(
        {
          agent: dep.agent_pubkey.slice(0, 12),
          bond_id: bond?.bond_id,
          sats: dep.amount_sats,
          payment_hash_first8: dep.payment_hash.slice(0, 8),
        },
        'AgentBondService: bond unlocked after HTLC settle (Phase 11B.6)',
      );
      return 'unlocked';
    }
    // CANCELED / EXPIRED → settled-as-failed. Bond stays locked.
    if (state === 'CANCELED' || state === 'EXPIRED' || state === 'UNKNOWN') {
      await this.deps.bondRepo.settlePendingDeposit(dep.payment_hash, nowSec);
      return 'failed';
    }
    // OPEN / SETTLED → not yet our turn. SETTLED w/o ACCEPTED is unusual
    // (someone settled out-of-band) — treat as failed-locked since we
    // can't release pending without our own settle.
    if (state === 'SETTLED') {
      // Out-of-band settle. Release the lock anyway since the agent did
      // pay ; logging captures the unusual flow.
      const bond = await this.deps.bondRepo.findByPaymentHash(dep.payment_hash);
      if (bond) await this.deps.bondRepo.releasePending(bond.bond_id, dep.amount_sats);
      await this.deps.bondRepo.settlePendingDeposit(dep.payment_hash, nowSec);
      logger.warn(
        { payment_hash_first8: dep.payment_hash.slice(0, 8) },
        'AgentBondService: pending deposit was already SETTLED on LND (out-of-band)',
      );
      return 'unlocked';
    }
    // OPEN → keep waiting. Past invoice expiry → cancel + fail.
    if (nowSec > dep.expires_at) {
      try {
        await lnd.cancel(dep.payment_hash);
      } catch {
        // best effort
      }
      await this.deps.bondRepo.settlePendingDeposit(dep.payment_hash, nowSec);
      return 'failed';
    }
    return 'skipped';
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
