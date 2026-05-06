// AEPS §8.5 (2026-05-07) — Fork detection service.
//
// Per the whitepaper :
//   "An operator who tries to anchor a different root for the same day
//    produces two L1 transactions. Both are public. A permissionless
//    observer scanning operator anchors detects the conflict, publishes a
//    fork-evidence Nostr event referencing both L1 transaction IDs, and
//    triggers a 5× slashing dispute. The observer earns 15% of the
//    slashing pool."
//
// This service implements the detection half. v0.1 :
//
// 1. recordObservation(...) accepts an observed anchor from any source
//    (self, l1, nostr, http, manual). Idempotent.
// 2. After every recorded observation, scan the (operator, day) bucket :
//    if ≥2 distinct root_hex values exist, emit a ForkEvent referencing
//    the two earliest observations. Idempotent on the lex-ordered (root_a,
//    root_b) pair, so detection from any observation order maps to a
//    single fork event row.
//
// Subsequent commits :
// - Nostr publication of the fork event as kind 31410.
// - Hook into ClaimEngine for the 5× slashing claim against the operator
//   bond.
// - L1 ingester (scan operator OP_RETURNs from a Bitcoin node).
import { logger } from '../logger';
import type {
  AepsObserverRepository,
  ForkEvent,
  ObservedAnchor,
  ObservationSource,
} from '../repositories/aepsObserverRepository';

export interface ForkDetectionServiceDeps {
  repo: AepsObserverRepository;
  now?: () => number;
}

export interface RecordObservationInput {
  operator_pubkey: string;
  day_utc: string;
  root_hex: string;
  source: ObservationSource;
  source_ref?: string | null;
}

export type RecordObservationResult =
  | { status: 'ok'; observation: ObservedAnchor; fork_event: ForkEvent | null }
  | { status: 'invalid_input'; reason: string };

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const HEX64_REGEX = /^[0-9a-f]{64}$/i;
const PUBKEY_REGEX = /^[0-9a-f]{64}$/i;

export class ForkDetectionService {
  private now: () => number;

  constructor(private readonly deps: ForkDetectionServiceDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async recordObservation(
    input: RecordObservationInput,
  ): Promise<RecordObservationResult> {
    if (!PUBKEY_REGEX.test(input.operator_pubkey)) {
      return { status: 'invalid_input', reason: 'operator_pubkey must be 64-char hex' };
    }
    if (!DAY_REGEX.test(input.day_utc)) {
      return { status: 'invalid_input', reason: 'day_utc must be YYYY-MM-DD' };
    }
    if (!HEX64_REGEX.test(input.root_hex)) {
      return { status: 'invalid_input', reason: 'root_hex must be 64-char hex' };
    }

    const observed = await this.deps.repo.recordObservation({
      operator_pubkey: input.operator_pubkey,
      day_utc: input.day_utc,
      root_hex: input.root_hex,
      source: input.source,
      source_ref: input.source_ref ?? null,
      observed_at: this.now(),
    });

    const forkEvent = await this.detectFork(input.operator_pubkey, input.day_utc);

    return { status: 'ok', observation: observed, fork_event: forkEvent };
  }

  /** Scan an (operator, day) bucket for distinct roots. If ≥2 distinct
   *  roots exist, record a fork event using the two lex-smallest roots.
   *
   *  Idempotent at the (operator, day) level : once a fork has been
   *  detected for this bucket, additional roots arriving later do NOT
   *  emit new fork events. The single canonical fork row is the slashing
   *  trigger ; multiple equivocations roll up into reinforcing observations
   *  but one claim. */
  async detectFork(operatorPubkey: string, dayUtc: string): Promise<ForkEvent | null> {
    const observations = await this.deps.repo.listObservationsForOperatorDay(
      operatorPubkey,
      dayUtc,
    );
    if (observations.length < 2) return null;

    // Group by root_hex; pick the earliest observation per root.
    const earliestByRoot = new Map<string, ObservedAnchor>();
    for (const obs of observations) {
      const existing = earliestByRoot.get(obs.root_hex);
      if (!existing || obs.observed_at < existing.observed_at) {
        earliestByRoot.set(obs.root_hex, obs);
      }
    }

    const roots = Array.from(earliestByRoot.keys()).sort();
    if (roots.length < 2) return null;

    // Pair the two lexicographically smallest roots — deterministic across
    // re-detection from any observation order.
    const rootA = roots[0];
    const rootB = roots[1];
    const obsA = earliestByRoot.get(rootA);
    const obsB = earliestByRoot.get(rootB);
    if (!obsA || !obsB) return null;

    // Idempotency : at most one fork event per (operator, day) bucket.
    // Additional roots arriving later do NOT emit new fork events ; the
    // first detected pair is the canonical slashing trigger.
    const existingFork = await this.deps.repo.findFirstForkEventForBucket(
      operatorPubkey,
      dayUtc,
    );

    const forkEvent = existingFork ?? (await this.deps.repo.recordForkEvent({
      operator_pubkey: operatorPubkey,
      day_utc: dayUtc,
      root_hex_a: rootA,
      root_hex_b: rootB,
      observation_id_a: obsA.observation_id,
      observation_id_b: obsB.observation_id,
      detected_at: this.now(),
    }));

    if (!existingFork) {
      logger.warn(
        {
          operator_pubkey: operatorPubkey.slice(0, 12),
          day_utc: dayUtc,
          root_a_first8: rootA.slice(0, 8),
          root_b_first8: rootB.slice(0, 8),
          fork_event_id: forkEvent.fork_event_id,
        },
        'AEPS §8.5: FORK DETECTED — two distinct daily roots for same operator+day',
      );
    }

    return forkEvent;
  }

  async listForks(
    operatorPubkey: string | null = null,
    limit = 100,
  ): Promise<ForkEvent[]> {
    return this.deps.repo.listForkEvents(operatorPubkey, limit);
  }
}
