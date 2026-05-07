// AEPS §8.5 (2026-05-08) — Nostr publication of detected fork events.
//
// Per the whitepaper, a fork is publicly slashable evidence : the operator
// anchored two different daily Merkle roots for the same UTC day. The
// fork event is broadcast to the network as a Nostr event (kind 31410,
// proposed) so other observers + claim-engines can ingest it without a
// HTTP API.
//
//   kind        : 31410
//   pubkey      : the OBSERVER's secp256k1 Nostr identity (anyone can
//                 publish, the per-observer 15% slashing reward is
//                 attributed by being the first observation that
//                 completed the fork pair)
//   tags        :
//     ["d", "<operator_pubkey>:<day_utc>"]   NIP-33 addressable
//     ["t", "aeps-fork"]                      filterable tag
//     ["op", "<operator_pubkey>"]             the EQUIVOCATING operator
//     ["day", "<day_utc>"]                    YYYY-MM-DD
//     ["root_a", "<root_hex>"]                lex-smaller of the two
//     ["root_b", "<root_hex>"]                lex-greater of the two
//     ["fork_event_id", "<bigint>"]           local id (debugging)
//     optional ["nostr_event_a", "<event_id>"] kind 31403 ref for root_a
//     optional ["nostr_event_b", "<event_id>"] kind 31403 ref for root_b
//   content     : "" (canonical evidence is in tags)
//
// Pure builder + signer. Network publication uses publishToRelays()
// helper (re-exported from aepsAnchorPublisher).
import type { ForkEvent } from '../repositories/aepsObserverRepository';

export const KIND_AEPS_FORK = 31410;

export interface AepsForkEventTemplate {
  kind: typeof KIND_AEPS_FORK;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface AepsForkEventSigned {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Build the unsigned event template for a fork event. Pure function. */
export function buildForkEventTemplate(
  fork: ForkEvent,
  nowSec: number,
  opts: { nostr_event_a?: string; nostr_event_b?: string } = {},
): AepsForkEventTemplate {
  const tags: string[][] = [
    ['d', `${fork.operator_pubkey}:${fork.day_utc}`],
    ['t', 'aeps-fork'],
    ['op', fork.operator_pubkey],
    ['day', fork.day_utc],
    ['root_a', fork.root_hex_a],
    ['root_b', fork.root_hex_b],
    ['fork_event_id', String(fork.fork_event_id)],
  ];
  if (opts.nostr_event_a) tags.push(['nostr_event_a', opts.nostr_event_a]);
  if (opts.nostr_event_b) tags.push(['nostr_event_b', opts.nostr_event_b]);
  return {
    kind: KIND_AEPS_FORK,
    created_at: nowSec,
    tags,
    content: '',
  };
}

/** Sign a fork event template with a 32-byte secp256k1 private key. */
export async function signForkEvent(
  template: AepsForkEventTemplate,
  secretKeyHex: string,
): Promise<AepsForkEventSigned> {
  // @ts-expect-error — nostr-tools is ESM, dynamic import works at runtime.
  const { finalizeEvent } = await import('nostr-tools/pure');
  const { hexToBytes } = await import('@noble/hashes/utils');
  const sk = hexToBytes(secretKeyHex);
  const signed = finalizeEvent(template, sk) as AepsForkEventSigned;
  return signed;
}

/** Convenience : build + sign in one call. */
export async function buildAndSignForkEvent(
  fork: ForkEvent,
  nowSec: number,
  secretKeyHex: string,
  opts: { nostr_event_a?: string; nostr_event_b?: string } = {},
): Promise<AepsForkEventSigned> {
  const template = buildForkEventTemplate(fork, nowSec, opts);
  return signForkEvent(template, secretKeyHex);
}
