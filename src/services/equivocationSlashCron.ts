// AEPS §10 + §7.2 (2026-05-08) — Equivocation slash settlement cron.
//
// Reserved equivocation slashes (recorded in aeps_oracle_slash_intents
// by the EquivocationClaimAdapter) are converted to permanent slashes
// after a short grace period. Per §7.2 distribution :
//
//   80% to the dispute beneficiary (the disputant who would have won
//        if the oracle voted honestly — i.e. the side OPPOSITE the
//        equivocation_a outcome ; for v0.1 we assume disputant_wins is
//        the canonical correct outcome and burn-credit the share until
//        a beneficiary lookup wires up)
//   15% to the observer / first-detector (for v0.1 the observer concept
//        is recorded but not paid out ; the share is burn-credited)
//    5% burned (deflationary)
//
// v0.1 SHIPS the state transition + the bond move + records the payout
// shares in aeps_oracle_slash_intents.payout_*_sats columns. Actual
// disbursement to disputant/observer wallets is a v0.2 follow-up that
// requires Lightning routing infrastructure. Until then, the disputant +
// observer shares are credited to a deferred-payout pool implicitly by
// staying recorded but unsent.
//
// The grace period (default 1 hour, env AEPS_EQUIVOCATION_GRACE_SEC)
// gives downstream systems time to react before the slash becomes
// irreversible. Equivocation evidence is cryptographically instant
// (both Schnorr sigs are proof) so the grace is operational courtesy,
// not a dispute window.
import { logger } from '../logger';
import type { AepsOracleSlashRepository, OracleSlashIntent } from '../repositories/aepsOracleSlashRepository';
import type { OperatorBondRepository } from '../repositories/operatorBondRepository';

const DEFAULT_GRACE_SEC = 3600;

const SHARE_DISPUTANT_BPS = 8000; // 80%
const SHARE_OBSERVER_BPS  = 1500; // 15%
const SHARE_BURNED_BPS    = 500;  //  5%
const TOTAL_BPS           = 10000;

export interface EquivocationSlashCronDeps {
  slashRepo: AepsOracleSlashRepository;
  bondRepo: OperatorBondRepository;
  graceSec?: number;
  now?: () => number;
}

export interface CycleResult {
  considered: number;
  executed: number;
  skipped_no_bond: number;
  skipped_pending_too_low: number;
  errors: number;
}

export class EquivocationSlashCron {
  private now: () => number;
  private graceSec: number;

  constructor(private readonly deps: EquivocationSlashCronDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.graceSec = deps.graceSec ?? DEFAULT_GRACE_SEC;
  }

  /** Single cycle : find reserved intents past grace, execute them. */
  async runCycle(): Promise<CycleResult> {
    const result: CycleResult = {
      considered: 0,
      executed: 0,
      skipped_no_bond: 0,
      skipped_pending_too_low: 0,
      errors: 0,
    };

    const ready = await this.deps.slashRepo.findReservedReady(this.graceSec, this.now());
    result.considered = ready.length;

    for (const intent of ready) {
      try {
        await this.executeOne(intent, result);
      } catch (err) {
        result.errors += 1;
        logger.error(
          {
            slash_intent_id: intent.slash_intent_id,
            error: err instanceof Error ? err.message : String(err),
          },
          'AEPS §10: equivocation slash settlement threw',
        );
      }
    }

    if (result.considered > 0) {
      logger.info(
        result,
        'AEPS §10: equivocation slash cron cycle complete',
      );
    }
    return result;
  }

  private async executeOne(intent: OracleSlashIntent, result: CycleResult): Promise<void> {
    if (intent.bond_id === null) {
      result.skipped_no_bond += 1;
      return;
    }

    // Atomic move : bond_pending_sats -= slash_sats, bond_slashed_sats += slash_sats.
    // Returns false if pending was reduced below slash_sats by another path.
    const committed = await this.deps.bondRepo.commitSlash(
      intent.bond_id,
      intent.slash_sats,
      this.now(),
    );
    if (!committed) {
      result.skipped_pending_too_low += 1;
      logger.warn(
        {
          slash_intent_id: intent.slash_intent_id,
          bond_id: intent.bond_id,
          slash_sats: intent.slash_sats,
        },
        'AEPS §10: commitSlash returned false — bond_pending_sats < slash_sats race',
      );
      return;
    }

    const payouts = computePayouts(intent.slash_sats);
    await this.deps.slashRepo.transitionToExecuted(
      intent.slash_intent_id,
      this.now(),
      payouts,
    );
    result.executed += 1;

    logger.warn(
      {
        slash_intent_id: intent.slash_intent_id,
        oracle_pubkey_first12: intent.oracle_pubkey.slice(0, 12),
        bond_id: intent.bond_id,
        slash_sats: intent.slash_sats,
        ...payouts,
      },
      'AEPS §10: equivocation slash executed (§7.2 distribution)',
    );
  }
}

/** Compute §7.2 distribution. Sum equals slash_sats (may have ±1 rounding
 *  on integer division — we put the rounding remainder in the burn share
 *  which is the most conservative — burned sats are deflationary). */
export function computePayouts(slashSats: number): {
  payout_disputant_sats: number;
  payout_observer_sats: number;
  payout_burned_sats: number;
} {
  if (slashSats < 0) throw new Error(`slashSats must be non-negative, got ${slashSats}`);
  const disputant = Math.floor((slashSats * SHARE_DISPUTANT_BPS) / TOTAL_BPS);
  const observer = Math.floor((slashSats * SHARE_OBSERVER_BPS) / TOTAL_BPS);
  // Burned absorbs rounding so the sum equals slashSats exactly.
  const burned = slashSats - disputant - observer;
  return {
    payout_disputant_sats: disputant,
    payout_observer_sats: observer,
    payout_burned_sats: burned,
  };
}
