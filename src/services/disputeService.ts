// AEPS §10 (2026-05-07) — Dispute resolution via BIP-340 Schnorr
// threshold oracle attestation.
//
// Dispute lifecycle :
//
//  openDispute(input)
//    → state = 'open', oracle_pubkeys + oracle_threshold locked
//
//  submitAttestation(dispute_id, oracle_pubkey, outcome, signature_hex)
//    → verify Schnorr sig over canonical outcome message
//    → reject if oracle not in dispute.oracle_pubkeys (anti-impersonation)
//    → reject if signature does not verify (anti-forgery)
//    → idempotent on (dispute_id, oracle_pubkey)
//    → after insert, recount per-outcome attestations
//    → if any outcome reaches threshold, resolve dispute
//
//  abortExpired() — cron tick, transitions open + past-expires_at → 'expired'
//
// The canonical outcome message bound to Schnorr signing :
//
//   canonical = JSON.stringify({
//     v: "AEPS-§10",
//     dispute_id: "<uuid>",
//     outcome: "disputant_wins" | "respondent_wins"
//   })   (canonical JSON sorted keys)
//   message = sha256(canonical)
//
// Same dispute, different outcome ⇒ different signed bytes ⇒ different
// signature. An oracle who signs both outcomes equivocates publicly ; the
// service stores both attestations only at the cost of overwriting (one
// attestation per oracle per dispute). Equivocation detection is a
// follow-up.
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { logger } from '../logger';
import { canonicalJson } from './signerService';
import type {
  AepsDisputeRepository,
  AepsDispute,
  AepsDisputeAttestation,
  DisputeType,
  AttestationOutcome,
  OracleEquivocation,
} from '../repositories/aepsDisputeRepository';

const DEFAULT_DISPUTE_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
const HEX_REGEX = /^[0-9a-f]+$/i;

const MULTIPLIERS_BY_TYPE: Record<DisputeType, number> = {
  content_correctness: 5,
  fork: 5,
  sla_breach: 3,
  false_dispute: 3,
  non_payment: 1,
};

/** Hook called when a dispute resolves (state → resolved_disputant or
 *  resolved_respondent). Returning a claim_id persists it on the dispute
 *  row so observers can join dispute → slashing claim. The hook runs after
 *  the state transition is committed ; failures are logged but don't roll
 *  back the resolution (the dispute is settled regardless of whether a
 *  Lightning slash succeeded). */
export type DisputeResolvedHook = (
  dispute: AepsDispute,
) => Promise<{ claim_id?: number } | void>;

/** Hook called when an oracle equivocates (signs both outcomes). The
 *  equivocation row is the publicly slashable evidence ; the hook is
 *  the integration point with ClaimEngine for the 5× slash against the
 *  oracle's bond. */
export type EquivocationDetectedHook = (
  equivocation: OracleEquivocation,
) => Promise<{ claim_id?: number } | void>;

export interface DisputeServiceDeps {
  repo: AepsDisputeRepository;
  onResolved?: DisputeResolvedHook;
  onEquivocation?: EquivocationDetectedHook;
  now?: () => number;
}

export interface OpenDisputeInput {
  disputant_pubkey: string;
  respondent_pubkey: string;
  dispute_type: DisputeType;
  receipt_id?: number;
  fork_event_id?: number;
  oracle_pubkeys: string[];
  oracle_threshold: number;
  ttl_sec?: number;
  dispute_reason?: string;
}

export type OpenDisputeResult =
  | { status: 'ok'; dispute: AepsDispute }
  | { status: 'invalid_input'; reason: string };

export type SubmitAttestationResult =
  | { status: 'ok'; attestation: AepsDisputeAttestation; dispute_state: AepsDispute['state'] }
  | { status: 'dispute_not_found' }
  | { status: 'dispute_not_open'; current: string }
  | { status: 'oracle_not_in_set' }
  | { status: 'invalid_signature' }
  | { status: 'invalid_input'; reason: string };

export class DisputeService {
  private now: () => number;

  constructor(private readonly deps: DisputeServiceDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async openDispute(input: OpenDisputeInput): Promise<OpenDisputeResult> {
    if (!isPubkey(input.disputant_pubkey)) {
      return { status: 'invalid_input', reason: 'disputant_pubkey must be 64-char hex' };
    }
    if (!isPubkey(input.respondent_pubkey)) {
      return { status: 'invalid_input', reason: 'respondent_pubkey must be 64-char hex' };
    }
    if (input.disputant_pubkey === input.respondent_pubkey) {
      return { status: 'invalid_input', reason: 'disputant and respondent must differ' };
    }
    if (!(input.dispute_type in MULTIPLIERS_BY_TYPE)) {
      return { status: 'invalid_input', reason: `unknown dispute_type ${input.dispute_type}` };
    }
    if (!Array.isArray(input.oracle_pubkeys) || input.oracle_pubkeys.length === 0) {
      return { status: 'invalid_input', reason: 'oracle_pubkeys required' };
    }
    if (input.oracle_pubkeys.length > 32) {
      return { status: 'invalid_input', reason: 'oracle_pubkeys limited to 32' };
    }
    for (const pk of input.oracle_pubkeys) {
      if (!isPubkey(pk)) {
        return { status: 'invalid_input', reason: 'every oracle_pubkey must be 64-char hex' };
      }
    }
    const dedupedOracles = Array.from(new Set(input.oracle_pubkeys.map(p => p.toLowerCase())));
    if (dedupedOracles.length !== input.oracle_pubkeys.length) {
      return { status: 'invalid_input', reason: 'oracle_pubkeys must be unique' };
    }
    if (
      !Number.isInteger(input.oracle_threshold) ||
      input.oracle_threshold < 1 ||
      input.oracle_threshold > dedupedOracles.length
    ) {
      return {
        status: 'invalid_input',
        reason: `oracle_threshold must be in [1, ${dedupedOracles.length}]`,
      };
    }
    if (input.dispute_reason && input.dispute_reason.length > 500) {
      return { status: 'invalid_input', reason: 'dispute_reason exceeds 500 chars' };
    }

    const dispute = await this.deps.repo.createDispute({
      dispute_id: generateDisputeId(),
      disputant_pubkey: input.disputant_pubkey,
      respondent_pubkey: input.respondent_pubkey,
      dispute_type: input.dispute_type,
      receipt_id: input.receipt_id ?? null,
      fork_event_id: input.fork_event_id ?? null,
      multiplier: MULTIPLIERS_BY_TYPE[input.dispute_type],
      oracle_pubkeys: dedupedOracles,
      oracle_threshold: input.oracle_threshold,
      expires_at: this.now() + (input.ttl_sec ?? DEFAULT_DISPUTE_TTL_SEC),
      created_at: this.now(),
      dispute_reason: input.dispute_reason ?? null,
    });

    logger.info(
      {
        dispute_id: dispute.dispute_id,
        type: input.dispute_type,
        multiplier: dispute.multiplier,
        oracles: dedupedOracles.length,
        threshold: input.oracle_threshold,
        disputant: input.disputant_pubkey.slice(0, 12),
        respondent: input.respondent_pubkey.slice(0, 12),
      },
      'AEPS §10: dispute opened',
    );

    return { status: 'ok', dispute };
  }

  async submitAttestation(
    disputeId: string,
    oraclePubkey: string,
    outcome: AttestationOutcome,
    signatureHex: string,
  ): Promise<SubmitAttestationResult> {
    if (!isPubkey(oraclePubkey)) {
      return { status: 'invalid_input', reason: 'oracle_pubkey must be 64-char hex' };
    }
    if (outcome !== 'disputant_wins' && outcome !== 'respondent_wins') {
      return { status: 'invalid_input', reason: 'outcome must be disputant_wins or respondent_wins' };
    }
    if (!HEX_REGEX.test(signatureHex) || signatureHex.length !== 128) {
      return { status: 'invalid_input', reason: 'signature_hex must be 128-char hex' };
    }

    const dispute = await this.deps.repo.findDispute(disputeId);
    if (!dispute) return { status: 'dispute_not_found' };
    if (dispute.state !== 'open') {
      return { status: 'dispute_not_open', current: dispute.state };
    }
    if (!dispute.oracle_pubkeys.includes(oraclePubkey.toLowerCase())) {
      return { status: 'oracle_not_in_set' };
    }

    const message = buildOutcomeMessageHash(disputeId, outcome);
    const valid = schnorrVerify(signatureHex, message, oraclePubkey);
    if (!valid) {
      return { status: 'invalid_signature' };
    }

    // Equivocation detection : check for a prior attestation by this oracle
    // with a DIFFERENT outcome. If found, this is publicly slashable.
    const priorAttestations = await this.deps.repo.listAttestations(disputeId);
    const oraclePkLower = oraclePubkey.toLowerCase();
    const prior = priorAttestations.find(a => a.oracle_pubkey === oraclePkLower);
    const isEquivocation = !!prior && prior.outcome !== outcome && !prior.equivocated;

    let equivocationEvent: OracleEquivocation | null = null;
    if (isEquivocation && prior) {
      equivocationEvent = await this.deps.repo.recordEquivocation({
        oracle_pubkey: oraclePkLower,
        dispute_id: disputeId,
        outcome_a: prior.outcome,
        signature_hex_a: prior.signature_hex,
        signed_at_a: prior.signed_at,
        outcome_b: outcome,
        signature_hex_b: signatureHex.toLowerCase(),
        signed_at_b: this.now(),
        detected_at: this.now(),
      });
      logger.warn(
        {
          dispute_id: disputeId,
          oracle_pubkey: oraclePkLower.slice(0, 12),
          outcome_a: prior.outcome,
          outcome_b: outcome,
          equivocation_id: equivocationEvent.equivocation_id,
        },
        'AEPS §10: ORACLE EQUIVOCATION DETECTED — both signatures recorded as publicly slashable evidence',
      );
    }

    const attestation = await this.deps.repo.recordAttestation({
      dispute_id: disputeId,
      oracle_pubkey: oraclePkLower,
      outcome,
      signature_hex: signatureHex.toLowerCase(),
      signed_at: this.now(),
    });

    // If equivocation detected, mark the (now-updated) attestation row as
    // equivocated so the threshold count excludes this oracle. The oracle
    // permanently loses their vote in this dispute.
    if (equivocationEvent) {
      await this.deps.repo.markAttestationEquivocated(disputeId, oraclePkLower);
    }

    // After recording, count per-outcome attestations EXCLUDING equivocated
    // votes and resolve if threshold reached.
    const allAttestations = await this.deps.repo.listAttestations(disputeId);
    // Mark in-memory : the attestation we just wrote was set equivocated above
    // but we re-read from repo so the flag is accurate.
    const counts = countByOutcome(allAttestations.filter(a => !a.equivocated));
    let newState: AepsDispute['state'] = 'open';
    if (counts.disputant_wins >= dispute.oracle_threshold) {
      newState = 'resolved_disputant';
    } else if (counts.respondent_wins >= dispute.oracle_threshold) {
      newState = 'resolved_respondent';
    }

    if (newState !== 'open') {
      await this.deps.repo.updateDisputeState(disputeId, newState, {
        resolved_at: this.now(),
      });
      logger.info(
        {
          dispute_id: disputeId,
          new_state: newState,
          threshold: dispute.oracle_threshold,
          counts,
        },
        'AEPS §10: dispute resolved by oracle threshold',
      );

      // (separate from below) — no equivocation flow needed here ; the
      // resolution itself was triggered by non-equivocating votes.
      // Fire the optional onResolved hook (e.g. ClaimEngine slashing). The
      // dispute resolution is already committed ; hook failures don't roll
      // back, they just log and continue. Returning a claim_id from the hook
      // links the dispute to the slashing claim.
      if (this.deps.onResolved) {
        try {
          // Fetch the freshly-updated dispute to pass the resolved state.
          const resolved = await this.deps.repo.findDispute(disputeId);
          if (resolved) {
            const hookResult = await this.deps.onResolved(resolved);
            if (hookResult && typeof hookResult === 'object' && hookResult.claim_id) {
              await this.deps.repo.updateDisputeState(disputeId, newState, {
                claim_id: hookResult.claim_id,
              });
            }
          }
        } catch (err) {
          logger.error(
            {
              dispute_id: disputeId,
              error: err instanceof Error ? err.message : String(err),
            },
            'AEPS §10: onResolved hook threw — dispute is resolved but slashing not triggered',
          );
        }
      }
    }

    // Fire the optional onEquivocation hook independently of resolution.
    // An oracle can equivocate without changing the threshold outcome, and
    // the slashing trigger is the equivocation event itself.
    if (equivocationEvent && this.deps.onEquivocation) {
      try {
        const hookResult = await this.deps.onEquivocation(equivocationEvent);
        if (hookResult && typeof hookResult === 'object' && hookResult.claim_id) {
          // Persist claim_id directly on the equivocation row via a small
          // raw query — there's no dedicated repo setter today and adding
          // one for one field is overkill.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const db = (this.deps.repo as unknown as { db: any }).db;
          await db.query(
            'UPDATE aeps_oracle_equivocations SET claim_id = $1 WHERE equivocation_id = $2',
            [hookResult.claim_id, equivocationEvent.equivocation_id],
          );
        }
      } catch (err) {
        logger.error(
          {
            equivocation_id: equivocationEvent.equivocation_id,
            error: err instanceof Error ? err.message : String(err),
          },
          'AEPS §10: onEquivocation hook threw — evidence persists but slashing not triggered',
        );
      }
    }

    return { status: 'ok', attestation, dispute_state: newState };
  }

  async abortExpired(): Promise<number> {
    const expired = await this.deps.repo.findExpiredOpenDisputes(this.now());
    let count = 0;
    for (const d of expired) {
      await this.deps.repo.updateDisputeState(d.dispute_id, 'expired', {
        resolved_at: this.now(),
      });
      count += 1;
    }
    if (count > 0) {
      logger.warn({ expired_count: count }, 'AEPS §10: expired open disputes');
    }
    return count;
  }
}

/** Build the canonical outcome message + sha256 it. Any conformant impl
 *  produces identical bytes for identical (disputeId, outcome). */
export function buildOutcomeMessage(
  disputeId: string,
  outcome: AttestationOutcome,
): string {
  return canonicalJson({
    v: 'AEPS-§10',
    dispute_id: disputeId,
    outcome,
  });
}

/** SHA-256 of the canonical outcome message — the 32 bytes BIP-340 signs. */
export function buildOutcomeMessageHash(
  disputeId: string,
  outcome: AttestationOutcome,
): Buffer {
  return createHash('sha256').update(buildOutcomeMessage(disputeId, outcome), 'utf8').digest();
}

/** BIP-340 Schnorr verify wrapper. Returns false on bad inputs (no throw). */
export function schnorrVerify(
  signatureHex: string,
  message: Buffer,
  pubkeyHex: string,
): boolean {
  try {
    return schnorr.verify(
      Buffer.from(signatureHex, 'hex'),
      message,
      Buffer.from(pubkeyHex, 'hex'),
    );
  } catch {
    return false;
  }
}

/** Test/operator helper : sign an outcome with a private key. Returns hex sig.
 *  auxRand is optional. When omitted, falls back to Node's randomBytes(32) —
 *  noble's default uses WebCrypto which isn't exposed in some test
 *  environments. Per BIP-340, deterministic auxRand (e.g. zeros) is also
 *  acceptable but sacrifices nonce-reuse resistance ; we provide real entropy. */
export function schnorrSignOutcome(
  privKeyHex: string,
  disputeId: string,
  outcome: AttestationOutcome,
  auxRand?: Buffer,
): string {
  const msg = buildOutcomeMessageHash(disputeId, outcome);
  const aux = auxRand ?? randomBytes(32);
  const sig = schnorr.sign(msg, Buffer.from(privKeyHex, 'hex'), aux);
  return Buffer.from(sig).toString('hex');
}

function isPubkey(s: unknown): boolean {
  return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);
}

function generateDisputeId(): string {
  return `dis_${randomBytes(16).toString('hex')}`;
}

function countByOutcome(
  attestations: AepsDisputeAttestation[],
): Record<AttestationOutcome, number> {
  const out: Record<AttestationOutcome, number> = { disputant_wins: 0, respondent_wins: 0 };
  for (const a of attestations) out[a.outcome] += 1;
  return out;
}

export type { AepsDispute, AepsDisputeAttestation };
