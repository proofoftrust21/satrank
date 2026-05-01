// Phase 7.2 (2026-05-01) — Operator bond posting flow.
//
// Operators post a refundable bond via Lightning hold-invoice. Bonds back the
// agent_claims that fire on Tier 2 delivery failures (see ClaimEngine in
// Phase 7.3). This service is the high-level orchestrator on top of
// OperatorBondRepository : it generates the LN hold-invoice, listens for
// settlement, and exposes admin actions (top-up, freeze, request-release).
//
// V1 simplifications :
//  - One bond per operator-pubkey at a time. Top-ups create a sibling row
//    (multiple `active` bonds aggregate via OperatorBondRepository.availableForOperator).
//  - Release flow : operator calls requestRelease(); bond moves to `frozen` ;
//    cron releases when no pending claims AND releasable_at elapsed.
//  - Cooldown default : 14 days. Override at deposit time via cooldownDays.
import { logger } from '../logger';
import type { LndHoldInvoiceService } from './lndHoldInvoiceService';
import type {
  OperatorBondRepository,
  OperatorBond,
} from '../repositories/operatorBondRepository';

const DEFAULT_COOLDOWN_SEC = 14 * 24 * 3600;
const MIN_BOND_SATS = 1000;     // refuse trivially small bonds (admin floor)
const MAX_BOND_SATS = 10_000_000; // 10M sats per bond cap (review for v2)

export interface BondDepositRequest {
  operator_pubkey: string;
  bond_sats: number;
  min_floor_sats?: number;     // default 100 (catalogue auto-delist threshold)
  cooldown_sec?: number;       // default 14 days
  memo?: string;
}

export type BondDepositResult =
  | {
      status: 'invoice_issued';
      bond_id: number;
      payment_request: string;
      payment_hash: string;
      expires_at: number;
    }
  | {
      status: 'lnd_unavailable';
      reason: string;
    }
  | {
      status: 'invalid_request';
      reason: string;
    };

export interface OperatorBondServiceDeps {
  bondRepo: OperatorBondRepository;
  holdInvoiceService?: LndHoldInvoiceService;
  now?: () => number;
}

export class OperatorBondService {
  private now: () => number;

  constructor(private readonly deps: OperatorBondServiceDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Operator initiates a bond deposit. SatRank issues a Lightning hold-invoice;
   *  on payment (HTLC accepted) the bond row is created. We use a hold-invoice
   *  rather than a normal invoice so the bond can be cleanly cancelled if the
   *  caller decides to back out. Settlement is performed by a separate watcher
   *  (TODO Phase 7.2.1) ; for v1 callers must explicitly call settleDeposit().
   *
   *  The bond row is created in `active` state immediately on deposit, with
   *  bond_committed_sats = invoice value. Releasable_at = now + cooldown_sec. */
  async createDeposit(req: BondDepositRequest): Promise<BondDepositResult> {
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
      return {
        status: 'lnd_unavailable',
        reason: 'LND hold-invoice service not configured',
      };
    }

    const expirySec = 3600;  // operator has 1 hour to pay the bond invoice
    let invoice;
    try {
      invoice = await this.deps.holdInvoiceService.addHoldInvoice({
        valueSat: req.bond_sats,
        memo: req.memo ?? `SatRank operator bond ${req.operator_pubkey.slice(0, 8)}`,
        expirySec,
      });
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'OperatorBondService: addHoldInvoice failed',
      );
      return {
        status: 'lnd_unavailable',
        reason: 'addHoldInvoice failed — see server logs',
      };
    }

    const nowSec = this.now();
    const bond = await this.deps.bondRepo.create({
      operator_pubkey: req.operator_pubkey,
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

  /** Operator-side : freeze a bond (no new claims can debit it). Used when
   *  operator pauses listings without yet requesting release. */
  async freeze(bondId: number, operatorPubkey: string): Promise<boolean> {
    const bond = await this.deps.bondRepo.findById(bondId);
    if (!bond) return false;
    if (bond.operator_pubkey !== operatorPubkey) return false;
    if (bond.state !== 'active') return false;
    return this.deps.bondRepo.setState(bondId, 'frozen');
  }

  /** Cron : auto-delist operators whose total available has dropped below
   *  their min_floor. Returns the list of operator pubkeys affected.
   *  Catalogue ranking should de-prioritize these operators (Phase 7.4 hook). */
  async findUnderfundedOperators(): Promise<string[]> {
    const bonds = await this.deps.bondRepo.findBelowFloor();
    const seen = new Set<string>();
    for (const b of bonds) seen.add(b.operator_pubkey);
    return [...seen];
  }

  /** Cron : bonds whose cooldown elapsed AND zero pending claims → release.
   *  Outbound payment to operator's pubkey via lndClient.payInvoice happens
   *  separately (Phase 7.2.1) ; this method just transitions the state. */
  async findReleasable(): Promise<OperatorBond[]> {
    return this.deps.bondRepo.findReleasable(this.now());
  }

  async availableForOperator(operatorPubkey: string): Promise<number> {
    return this.deps.bondRepo.availableForOperator(operatorPubkey);
  }
}
