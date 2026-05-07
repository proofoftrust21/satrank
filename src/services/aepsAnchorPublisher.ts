// AEPS §8.3 (2026-05-07) — Nostr publication of daily Merkle anchors.
//
// Per the whitepaper, the L1 anchor transaction is gossiped as a Nostr
// event (kind 31403, proposed) for fast discovery without requiring a
// Bitcoin full node :
//
//   kind        : 31403
//   pubkey      : operator's secp256k1 Nostr identity
//   tags        :
//     ["d", "<operator_pubkey>:<day_utc>"]   NIP-33 addressable
//     ["t", "aeps-anchor"]                    filterable tag
//     ["op", "<operator_pubkey>"]             operator x-only pubkey
//     ["day", "<day_utc>"]                    YYYY-MM-DD
//     ["root", "<root_hex>"]                  64-char SHA-256
//     ["receipts", "<count>"]                 number of receipts in tree
//     optional ["l1_txid", "<txid>"]          when broadcast on L1
//     optional ["l1_block", "<height>"]       when confirmed
//   content     : ""
//
// This module ships the pure event-builder + signer. Network publication
// (relay connect + publish + ACK) is the cron's responsibility ; keeping
// the builder pure makes it conformance-testable across reference impls.
import type { DailyMerkleAnchor } from '../repositories/dailyMerkleAnchorRepository';

export const KIND_AEPS_ANCHOR = 31403;

export interface AepsAnchorEventTemplate {
  kind: typeof KIND_AEPS_ANCHOR;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface AepsAnchorEventSigned {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Build the unsigned event template for a daily anchor. Pure function. */
export function buildAnchorEventTemplate(
  anchor: DailyMerkleAnchor,
  nowSec: number,
): AepsAnchorEventTemplate {
  const tags: string[][] = [
    ['d', `${anchor.operator_pubkey}:${anchor.day_utc}`],
    ['t', 'aeps-anchor'],
    ['op', anchor.operator_pubkey],
    ['day', anchor.day_utc],
    ['root', anchor.root_hex],
    ['receipts', String(anchor.receipt_count)],
  ];
  if (anchor.l1_txid) tags.push(['l1_txid', anchor.l1_txid]);
  if (anchor.l1_block_height !== null) tags.push(['l1_block', String(anchor.l1_block_height)]);
  return {
    kind: KIND_AEPS_ANCHOR,
    created_at: nowSec,
    tags,
    content: '',
  };
}

/** Sign the template with a 32-byte secp256k1 private key. Returns the
 *  finalized Nostr event ready to publish. Lazy-imports nostr-tools to
 *  avoid pulling the ESM module into the cold path of callers that never
 *  publish. */
export async function signAnchorEvent(
  template: AepsAnchorEventTemplate,
  secretKeyHex: string,
): Promise<AepsAnchorEventSigned> {
  // @ts-expect-error — nostr-tools is ESM, dynamic import works at runtime.
  const { finalizeEvent } = await import('nostr-tools/pure');
  const { hexToBytes } = await import('@noble/hashes/utils');
  const sk = hexToBytes(secretKeyHex);
  const signed = finalizeEvent(template, sk) as AepsAnchorEventSigned;
  return signed;
}

/** Convenience : build + sign in one call. */
export async function buildAndSignAnchorEvent(
  anchor: DailyMerkleAnchor,
  nowSec: number,
  secretKeyHex: string,
): Promise<AepsAnchorEventSigned> {
  const template = buildAnchorEventTemplate(anchor, nowSec);
  return signAnchorEvent(template, secretKeyHex);
}
