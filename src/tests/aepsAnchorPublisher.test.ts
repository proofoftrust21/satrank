// AEPS §8.3 — Nostr anchor event-builder + signer tests.
import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes, webcrypto } from 'node:crypto';
import {
  KIND_AEPS_ANCHOR,
  buildAnchorEventTemplate,
  signAnchorEvent,
} from '../services/aepsAnchorPublisher';
import type { DailyMerkleAnchor } from '../repositories/dailyMerkleAnchorRepository';

// Some test runtimes don't expose crypto.getRandomValues globally even
// though Node provides it via webcrypto. nostr-tools' finalizeEvent
// (via @noble/hashes/utils.randomBytes) needs it. Polyfill if missing.
beforeAll(() => {
  const g = globalThis as unknown as { crypto?: { getRandomValues?: unknown } };
  if (!g.crypto?.getRandomValues) {
    g.crypto = webcrypto as unknown as typeof globalThis.crypto;
  }
});

function fixture(overrides: Partial<DailyMerkleAnchor> = {}): DailyMerkleAnchor {
  return {
    anchor_id: 1,
    day_utc: '2026-05-07',
    operator_pubkey: 'aa'.repeat(32),
    root_hex: 'cd'.repeat(32),
    receipt_count: 42,
    receipt_first_id: 100,
    receipt_last_id: 141,
    l1_txid: null,
    l1_block_height: null,
    l1_op_return_hex: null,
    l1_broadcast_at: null,
    nostr_event_id: null,
    nostr_published_at: null,
    computed_at: 1714759200,
    ...overrides,
  };
}

describe('AEPS §8.3 — Nostr anchor event builder', () => {
  it('uses kind 31403', () => {
    const tmpl = buildAnchorEventTemplate(fixture(), 1714759200);
    expect(tmpl.kind).toBe(31403);
    expect(tmpl.kind).toBe(KIND_AEPS_ANCHOR);
  });

  it('sets created_at from nowSec', () => {
    const tmpl = buildAnchorEventTemplate(fixture(), 1700000000);
    expect(tmpl.created_at).toBe(1700000000);
  });

  it('sets empty content', () => {
    const tmpl = buildAnchorEventTemplate(fixture(), 1);
    expect(tmpl.content).toBe('');
  });

  it('emits NIP-33 d-tag = operator:day', () => {
    const tmpl = buildAnchorEventTemplate(fixture(), 1);
    const dTag = tmpl.tags.find(t => t[0] === 'd');
    expect(dTag).toEqual(['d', 'aa'.repeat(32) + ':2026-05-07']);
  });

  it('emits aeps-anchor t-tag', () => {
    const tmpl = buildAnchorEventTemplate(fixture(), 1);
    expect(tmpl.tags.some(t => t[0] === 't' && t[1] === 'aeps-anchor')).toBe(true);
  });

  it('emits op/day/root/receipts tags', () => {
    const tmpl = buildAnchorEventTemplate(fixture(), 1);
    const tags = Object.fromEntries(tmpl.tags.map(t => [t[0], t[1]]));
    expect(tags.op).toBe('aa'.repeat(32));
    expect(tags.day).toBe('2026-05-07');
    expect(tags.root).toBe('cd'.repeat(32));
    expect(tags.receipts).toBe('42');
  });

  it('omits L1 tags when l1_txid null', () => {
    const tmpl = buildAnchorEventTemplate(fixture(), 1);
    expect(tmpl.tags.some(t => t[0] === 'l1_txid')).toBe(false);
    expect(tmpl.tags.some(t => t[0] === 'l1_block')).toBe(false);
  });

  it('emits L1 tags when present', () => {
    const tmpl = buildAnchorEventTemplate(
      fixture({ l1_txid: 'ab'.repeat(32), l1_block_height: 850000 }),
      1,
    );
    expect(tmpl.tags.some(t => t[0] === 'l1_txid' && t[1] === 'ab'.repeat(32))).toBe(true);
    expect(tmpl.tags.some(t => t[0] === 'l1_block' && t[1] === '850000')).toBe(true);
  });

  it('produces deterministic tags for same anchor + same now', () => {
    const a = buildAnchorEventTemplate(fixture(), 1714759200);
    const b = buildAnchorEventTemplate(fixture(), 1714759200);
    expect(a.tags).toEqual(b.tags);
    expect(a.created_at).toBe(b.created_at);
  });

  it('signs the event and produces a valid id + sig', async () => {
    const sk = Buffer.from(randomBytes(32)).toString('hex');
    const tmpl = buildAnchorEventTemplate(fixture(), 1714759200);
    const signed = await signAnchorEvent(tmpl, sk);
    expect(signed.kind).toBe(31403);
    expect(signed.created_at).toBe(1714759200);
    expect(signed.id).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(signed.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.tags).toEqual(tmpl.tags);
    expect(signed.content).toBe('');
  });
});
