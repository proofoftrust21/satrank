// AEPS §6.3 (2026-05-07) — Multi-hop chain orchestrator state machine.
//
// The agent generates a 32-byte preimage r and computes H = sha256(r). All
// N legs of the chain are locked with a Lightning hold-invoice keyed to H.
// The agent reveals r to the final operator only ; LN propagates r back
// through every leg, settling them atomically. Either every leg settles or
// any single timeout aborts the entire chain and refunds all locked legs.
//
// State machine :
//   chain  : planning → locked → settling → complete
//                              ↘ aborted
//   leg    : planned  → locked  → settled
//                               ↘ aborted
//
// Transitions :
//   planChain(input)                : creates chain in 'planning' with N
//                                     legs in 'planned'.
//   lockLeg(chain_id, leg_index)    : leg planned → locked. When all N legs
//                                     are locked, chain → 'locked'.
//   revealPreimage(chain_id, r)     : asserts sha256(r) == preimage_hash,
//                                     chain locked → settling.
//   settleLeg(chain_id, leg_index)  : leg locked → settled. When all N legs
//                                     are settled, chain → 'complete'.
//   abortChain(chain_id, reason)    : chain → aborted, all non-settled legs
//                                     → aborted (subsequent refund handling
//                                     is the orchestrator's job).
//
// v0.1 of this service is the pure state machine. Real Lightning integration
// (creating BOLT11 hold-invoices with the agent-supplied payment_hash) is
// gated by operator capability advertisement (`multi_hop_capable: true` in
// AEPS §4 capability descriptor). Until operators opt in, the orchestrator
// runs the state machine against mock htlc_refs.
import { createHash, randomBytes } from 'node:crypto';
import { logger } from '../logger';
import type {
  MultiHopChainRepository,
  MultiHopChain,
  MultiHopLeg,
  CreateLegInput,
} from '../repositories/multiHopChainRepository';

const DEFAULT_CHAIN_TTL_SEC = 600;

export interface MultiHopChainServiceDeps {
  repo: MultiHopChainRepository;
  now?: () => number;
}

export interface PlanChainInput {
  agent_pubkey: string;
  legs: ReadonlyArray<{
    endpoint_id: string;
    operator_pubkey: string;
    amount_msat: number;
    request_body_sha256: string;
  }>;
  ttl_sec?: number;
}

export type PlanChainResult =
  | { status: 'ok'; chain: MultiHopChain; preimage_hex: string }
  | { status: 'invalid_input'; reason: string };

export type LockLegResult =
  | { status: 'ok'; chain_state: MultiHopChain['state'] }
  | { status: 'chain_not_found' }
  | { status: 'leg_not_found' }
  | { status: 'invalid_state'; current: string };

export type RevealPreimageResult =
  | { status: 'ok' }
  | { status: 'chain_not_found' }
  | { status: 'preimage_mismatch' }
  | { status: 'invalid_state'; current: string };

export type SettleLegResult =
  | { status: 'ok'; chain_state: MultiHopChain['state'] }
  | { status: 'chain_not_found' }
  | { status: 'leg_not_found' }
  | { status: 'invalid_state'; current: string };

export type AbortChainResult =
  | { status: 'ok'; legs_aborted: number }
  | { status: 'chain_not_found' }
  | { status: 'already_terminal'; current: string };

export class MultiHopChainService {
  private now: () => number;

  constructor(private readonly deps: MultiHopChainServiceDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async planChain(input: PlanChainInput): Promise<PlanChainResult> {
    if (input.legs.length < 2) {
      return { status: 'invalid_input', reason: 'multihop chain requires >= 2 legs' };
    }
    if (input.legs.length > 16) {
      return { status: 'invalid_input', reason: 'multihop chain limited to 16 legs' };
    }
    for (const leg of input.legs) {
      if (leg.amount_msat <= 0) {
        return { status: 'invalid_input', reason: 'leg amount_msat must be positive' };
      }
      if (!/^[0-9a-f]{64}$/i.test(leg.request_body_sha256)) {
        return { status: 'invalid_input', reason: 'request_body_sha256 must be 64-char hex' };
      }
    }

    const preimage = randomBytes(32);
    const preimageHash = createHash('sha256').update(preimage).digest('hex');
    const preimageHex = preimage.toString('hex');
    const chainId = generateChainId();
    const nowSec = this.now();
    const expiresAt = nowSec + (input.ttl_sec ?? DEFAULT_CHAIN_TTL_SEC);
    const totalAmount = input.legs.reduce((acc, l) => acc + l.amount_msat, 0);

    const chain = await this.deps.repo.createChain({
      chain_id: chainId,
      agent_pubkey: input.agent_pubkey,
      preimage_hash: preimageHash,
      total_amount_msat: totalAmount,
      n_legs: input.legs.length,
      created_at: nowSec,
      expires_at: expiresAt,
    });

    const legInputs: CreateLegInput[] = input.legs.map((l, i) => ({
      chain_id: chainId,
      leg_index: i,
      endpoint_id: l.endpoint_id,
      operator_pubkey: l.operator_pubkey,
      amount_msat: l.amount_msat,
      request_body_sha256: l.request_body_sha256,
    }));
    await this.deps.repo.createLegs(legInputs);

    logger.info(
      {
        chain_id: chainId,
        agent_pubkey: input.agent_pubkey.slice(0, 12),
        n_legs: input.legs.length,
        total_amount_msat: totalAmount,
        preimage_hash_first8: preimageHash.slice(0, 8),
      },
      'AEPS §6.3: multihop chain planned',
    );

    return { status: 'ok', chain, preimage_hex: preimageHex };
  }

  async lockLeg(chainId: string, legIndex: number, htlcRef: string): Promise<LockLegResult> {
    const chain = await this.deps.repo.findChain(chainId);
    if (!chain) return { status: 'chain_not_found' };
    if (chain.state !== 'planning') return { status: 'invalid_state', current: chain.state };

    const legs = await this.deps.repo.listLegs(chainId);
    const leg = legs.find(l => l.leg_index === legIndex);
    if (!leg) return { status: 'leg_not_found' };
    if (leg.state !== 'planned') return { status: 'invalid_state', current: leg.state };

    const nowSec = this.now();
    await this.deps.repo.updateLegState(chainId, legIndex, 'locked', {
      htlc_ref: htlcRef,
      locked_at: nowSec,
    });

    // If this lock completed the set, transition chain → locked.
    const updated = await this.deps.repo.listLegs(chainId);
    const allLocked = updated.every(l => l.state === 'locked');
    if (allLocked) {
      await this.deps.repo.updateChainState(chainId, 'locked');
      return { status: 'ok', chain_state: 'locked' };
    }
    return { status: 'ok', chain_state: 'planning' };
  }

  async revealPreimage(chainId: string, preimageHex: string): Promise<RevealPreimageResult> {
    if (!/^[0-9a-f]{64}$/i.test(preimageHex)) {
      return { status: 'preimage_mismatch' };
    }
    const chain = await this.deps.repo.findChain(chainId);
    if (!chain) return { status: 'chain_not_found' };
    if (chain.state !== 'locked') return { status: 'invalid_state', current: chain.state };

    const computedHash = createHash('sha256')
      .update(Buffer.from(preimageHex, 'hex'))
      .digest('hex');
    if (computedHash !== chain.preimage_hash) {
      return { status: 'preimage_mismatch' };
    }

    await this.deps.repo.updateChainState(chainId, 'settling', {
      preimage_revealed: preimageHex,
    });
    logger.info(
      { chain_id: chainId, preimage_first8: preimageHex.slice(0, 8) },
      'AEPS §6.3: preimage revealed → settling',
    );
    return { status: 'ok' };
  }

  async settleLeg(chainId: string, legIndex: number): Promise<SettleLegResult> {
    const chain = await this.deps.repo.findChain(chainId);
    if (!chain) return { status: 'chain_not_found' };
    if (chain.state !== 'settling' && chain.state !== 'locked') {
      // Allow settle from 'locked' to support legs settling concurrently with
      // the chain transition to 'settling' (preimage just revealed).
      return { status: 'invalid_state', current: chain.state };
    }

    const legs = await this.deps.repo.listLegs(chainId);
    const leg = legs.find(l => l.leg_index === legIndex);
    if (!leg) return { status: 'leg_not_found' };
    if (leg.state !== 'locked') return { status: 'invalid_state', current: leg.state };

    const nowSec = this.now();
    await this.deps.repo.updateLegState(chainId, legIndex, 'settled', {
      settled_at: nowSec,
    });

    const updated = await this.deps.repo.listLegs(chainId);
    const allSettled = updated.every(l => l.state === 'settled');
    if (allSettled) {
      await this.deps.repo.updateChainState(chainId, 'complete', {
        settled_at: nowSec,
      });
      logger.info({ chain_id: chainId }, 'AEPS §6.3: chain complete');
      return { status: 'ok', chain_state: 'complete' };
    }
    return { status: 'ok', chain_state: chain.state === 'locked' ? 'settling' : chain.state };
  }

  async abortChain(chainId: string, reason: string): Promise<AbortChainResult> {
    const chain = await this.deps.repo.findChain(chainId);
    if (!chain) return { status: 'chain_not_found' };
    if (chain.state === 'complete' || chain.state === 'aborted') {
      return { status: 'already_terminal', current: chain.state };
    }

    const nowSec = this.now();
    const legs = await this.deps.repo.listLegs(chainId);
    let abortedCount = 0;
    for (const leg of legs) {
      if (leg.state === 'planned' || leg.state === 'locked') {
        await this.deps.repo.updateLegState(chainId, leg.leg_index, 'aborted');
        abortedCount += 1;
      }
    }
    await this.deps.repo.updateChainState(chainId, 'aborted', {
      aborted_at: nowSec,
      abort_reason: reason,
    });
    logger.warn(
      { chain_id: chainId, reason, legs_aborted: abortedCount },
      'AEPS §6.3: chain aborted',
    );
    return { status: 'ok', legs_aborted: abortedCount };
  }

  /** Cron helper : abort chains whose expires_at has passed. */
  async abortExpired(): Promise<number> {
    const expired = await this.deps.repo.findExpiredActiveChains(this.now());
    let aborted = 0;
    for (const chain of expired) {
      const result = await this.abortChain(chain.chain_id, 'expired');
      if (result.status === 'ok') aborted += 1;
    }
    return aborted;
  }
}

/** Generate a chain_id : `mhc_<32 random hex>`. Not security-critical (chain
 *  ownership is enforced by agent_pubkey), but distinct enough to avoid
 *  collision in tests + audit logs. */
function generateChainId(): string {
  return `mhc_${randomBytes(16).toString('hex')}`;
}

/** Pure helper exposed for tests : deterministic preimage_hash from preimage hex. */
export function computePreimageHash(preimageHex: string): string {
  return createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex');
}

export type { MultiHopChain, MultiHopLeg };
