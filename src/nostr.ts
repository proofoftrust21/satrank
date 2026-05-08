// SatRank V3 — Nostr signer + publisher.
//
// Signs kind 30782 trust assertions and publishes them to a relay set.
// One file. No reuse of nostr-tools' high-level NIP-XX helpers — just the
// primitives (finalizeEvent + Relay).

import { finalizeEvent, getPublicKey, verifyEvent as nostrVerifyEvent, type EventTemplate, type Event as NostrEvent } from 'nostr-tools/pure';
import { Relay } from 'nostr-tools/relay';
import { hexToBytes } from '@noble/hashes/utils';
import { config } from './config.js';
import { logger } from './logger.js';
import type { EndpointScore } from './types.js';

export function nostrEnabled(): boolean {
  return !!config.NOSTR_PRIVATE_KEY;
}

export function oraclePubkey(): string | null {
  if (!config.NOSTR_PRIVATE_KEY) return null;
  return getPublicKey(hexToBytes(config.NOSTR_PRIVATE_KEY));
}

/** Build a kind 30782 trust assertion for an endpoint. Pure; signs but
 *  does not publish. The d-tag is the url_hash so replaceable-event
 *  semantics apply (one assertion per endpoint at any time). */
export function buildAssertion(score: EndpointScore, valid_until: number): NostrEvent {
  if (!config.NOSTR_PRIVATE_KEY) throw new Error('NOSTR_PRIVATE_KEY not set');
  const tpl: EventTemplate = {
    kind: 30782,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', score.url_hash],
      ['url', score.url],
      ['category', score.category],
      ['p_e2e', score.p_e2e.toFixed(6)],
      ['n_obs', String(score.n_obs)],
      ['valid_until', String(valid_until)],
    ],
    content: JSON.stringify({
      url: score.url,
      url_hash: score.url_hash,
      p_e2e: score.p_e2e,
      stages: Object.fromEntries(Object.entries(score.stages).map(([k, v]) => [k, { mean: v.mean, ci95: v.ci95, n: v.n }])),
      n_obs: score.n_obs,
      median_latency_ms: score.median_latency_ms,
      valid_until,
    }),
  };
  return finalizeEvent(tpl, hexToBytes(config.NOSTR_PRIVATE_KEY));
}

/** Publish to all configured relays. Returns the count of relays that ACKed. */
export async function publish(event: NostrEvent): Promise<{ acked: number; attempted: number }> {
  const relayUrls = config.NOSTR_RELAYS.split(',').map((s) => s.trim()).filter(Boolean);
  let acked = 0;
  await Promise.all(relayUrls.map(async (url) => {
    try {
      const relay = await Relay.connect(url);
      try {
        await relay.publish(event);
        acked++;
      } finally {
        relay.close();
      }
    } catch (err: unknown) {
      logger.warn({ url, err: (err as Error).message }, 'nostr: publish failed');
    }
  }));
  return { acked, attempted: relayUrls.length };
}

/** Verify the Schnorr signature + structural shape of a Nostr event.
 *  Pure function ; no network. Used by the verify_assertion MCP tool. */
export function verifyEvent(event: NostrEvent): boolean {
  return nostrVerifyEvent(event);
}
