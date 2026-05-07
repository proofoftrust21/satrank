// AEPS §10 (2026-05-08) — Equivocation → operator-bond slash adapter.
//
// Wires DisputeService.onEquivocation to the operator_bond pending-reserve
// mechanism. On equivocation detected :
//
// 1. Compute slash_sats = 5 × EQUIVOCATION_BASELINE_SATS.
// 2. Look up oracle's active operator_bond.
// 3. If bond found AND has enough headroom :
//    - reservePending(bond_id, slash_sats) on the bond.
//    - Persist aeps_oracle_slash_intents row with state='reserved'.
//    - Return { slash_intent_id } so the equivocation row links to it
//      (via the existing claim_id field).
// 4. If no bond found :
//    - Persist intent with state='no_bond_found'. Oracle has no skin in
//      the game ; the equivocation evidence is permanent + Nostr-
//      publishable, but no economic punishment is possible.
//
// Settlement (state=executed + actual bond_slashed_sats move) is a
// separate cron that runs after the dispute window expires. v0.1 only
// handles the reservation. v0.2 will :
//   - Move slash_sats from bond_pending_sats to bond_slashed_sats.
//   - Distribute per §7.2 : 80% to the equivocation-beneficiary
//     disputant, 15% to the observer who first detected, 5% burned.
//
// This adapter is a pure function ; wired in app.ts as the onEquivocation
// hook on DisputeService.
import { logger } from '../logger';
import type { OracleEquivocation } from '../repositories/aepsDisputeRepository';
import type { OperatorBondRepository } from '../repositories/operatorBondRepository';
import type {
  AepsOracleSlashRepository,
  OracleSlashIntent,
} from '../repositories/aepsOracleSlashRepository';

/** 5× multiplier per §10.1 against a baseline that the operator can
 *  override at deployment time. Default 50 000 sats × 5 = 250 000 sats slash. */
const EQUIVOCATION_BASELINE_SATS_DEFAULT = 50_000;
const EQUIVOCATION_MULTIPLIER = 5;

export interface EquivocationClaimAdapterDeps {
  bondRepo: OperatorBondRepository;
  slashRepo: AepsOracleSlashRepository;
  baselineSatsOverride?: number;
  now?: () => number;
}

export type EquivocationSlashResult =
  | { status: 'reserved'; slash_intent_id: number; bond_id: number; slash_sats: number }
  | { status: 'no_bond_found'; slash_intent_id: number }
  | { status: 'underfunded'; slash_intent_id: number; bond_id: number; needed: number; available: number }
  | { status: 'race_lost'; slash_intent_id: number };

export class EquivocationClaimAdapter {
  private now: () => number;
  private baselineSats: number;

  constructor(private readonly deps: EquivocationClaimAdapterDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.baselineSats = deps.baselineSatsOverride ?? EQUIVOCATION_BASELINE_SATS_DEFAULT;
  }

  async openSlashForEquivocation(
    equivocation: OracleEquivocation,
  ): Promise<EquivocationSlashResult> {
    const slashSats = this.baselineSats * EQUIVOCATION_MULTIPLIER;
    const oraclePubkey = equivocation.oracle_pubkey.toLowerCase();

    // Re-entry safety : if a slash intent already exists for this
    // equivocation, return its current state without re-reserving.
    const existing = await this.deps.slashRepo.findByEquivocation(equivocation.equivocation_id);
    if (existing) {
      return mapExisting(existing, slashSats);
    }

    const bonds = await this.deps.bondRepo.findActiveByOperator(oraclePubkey);
    if (bonds.length === 0) {
      const intent = await this.deps.slashRepo.createOrGet({
        oracle_pubkey: oraclePubkey,
        equivocation_id: equivocation.equivocation_id,
        bond_id: null,
        slash_sats: slashSats,
        state: 'no_bond_found',
        created_at: this.now(),
      });
      logger.warn(
        {
          equivocation_id: equivocation.equivocation_id,
          oracle_pubkey: oraclePubkey.slice(0, 12),
          slash_sats: slashSats,
        },
        'AEPS §10: oracle equivocation but no bond — evidence permanent, no economic slash possible',
      );
      return { status: 'no_bond_found', slash_intent_id: intent.slash_intent_id };
    }

    // Pick the first bond with enough headroom.
    let chosenBond = null;
    let availableOnChosen = 0;
    for (const b of bonds) {
      const avail = b.bond_committed_sats - b.bond_slashed_sats - b.bond_pending_sats;
      if (avail >= slashSats) {
        chosenBond = b;
        availableOnChosen = avail;
        break;
      }
    }

    if (!chosenBond) {
      // Take the largest bond as the "best effort" reference for
      // diagnostics, but record state=recorded (we couldn't reserve).
      const intent = await this.deps.slashRepo.createOrGet({
        oracle_pubkey: oraclePubkey,
        equivocation_id: equivocation.equivocation_id,
        bond_id: bonds[0].bond_id,
        slash_sats: slashSats,
        state: 'recorded',
        created_at: this.now(),
      });
      logger.warn(
        {
          equivocation_id: equivocation.equivocation_id,
          oracle_pubkey: oraclePubkey.slice(0, 12),
          slash_sats: slashSats,
          best_available: bonds.reduce(
            (acc, b) => Math.max(acc, b.bond_committed_sats - b.bond_slashed_sats - b.bond_pending_sats),
            0,
          ),
        },
        'AEPS §10: oracle bond underfunded for 5× equivocation slash — intent recorded',
      );
      const bestAvail = bonds.reduce(
        (acc, b) => Math.max(acc, b.bond_committed_sats - b.bond_slashed_sats - b.bond_pending_sats),
        0,
      );
      return {
        status: 'underfunded',
        slash_intent_id: intent.slash_intent_id,
        bond_id: bonds[0].bond_id,
        needed: slashSats,
        available: bestAvail,
      };
    }

    // Reserve bond_pending_sats. If the race is lost (concurrent claim
    // grabbed the headroom first), record state=recorded and return
    // race_lost so the cron can retry.
    const reserved = await this.deps.bondRepo.reservePending(chosenBond.bond_id, slashSats);
    if (!reserved) {
      const intent = await this.deps.slashRepo.createOrGet({
        oracle_pubkey: oraclePubkey,
        equivocation_id: equivocation.equivocation_id,
        bond_id: chosenBond.bond_id,
        slash_sats: slashSats,
        state: 'recorded',
        created_at: this.now(),
      });
      return { status: 'race_lost', slash_intent_id: intent.slash_intent_id };
    }

    const intent = await this.deps.slashRepo.createOrGet({
      oracle_pubkey: oraclePubkey,
      equivocation_id: equivocation.equivocation_id,
      bond_id: chosenBond.bond_id,
      slash_sats: slashSats,
      state: 'reserved',
      created_at: this.now(),
      reserved_at: this.now(),
    });

    logger.warn(
      {
        equivocation_id: equivocation.equivocation_id,
        slash_intent_id: intent.slash_intent_id,
        oracle_pubkey: oraclePubkey.slice(0, 12),
        bond_id: chosenBond.bond_id,
        slash_sats: slashSats,
        bond_available_after: availableOnChosen - slashSats,
      },
      'AEPS §10: oracle equivocation slash reserved on operator bond (5×)',
    );

    return {
      status: 'reserved',
      slash_intent_id: intent.slash_intent_id,
      bond_id: chosenBond.bond_id,
      slash_sats: slashSats,
    };
  }
}

function mapExisting(
  existing: OracleSlashIntent,
  slashSats: number,
): EquivocationSlashResult {
  if (existing.state === 'reserved' || existing.state === 'executed') {
    return {
      status: 'reserved',
      slash_intent_id: existing.slash_intent_id,
      bond_id: existing.bond_id ?? 0,
      slash_sats: existing.slash_sats,
    };
  }
  if (existing.state === 'no_bond_found') {
    return { status: 'no_bond_found', slash_intent_id: existing.slash_intent_id };
  }
  // 'recorded' or 'expired' — treat as race_lost so caller can retry.
  return {
    status: 'race_lost',
    slash_intent_id: existing.slash_intent_id,
  };
  void slashSats;
}
