// AEPS §8.5 — kind 31410 fork event builder + signer tests.
import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes, webcrypto } from 'node:crypto';
import {
  KIND_AEPS_FORK,
  buildForkEventTemplate,
  signForkEvent,
} from '../services/aepsForkPublisher';
import type { ForkEvent } from '../repositories/aepsObserverRepository';

beforeAll(() => {
  const g = globalThis as unknown as { crypto?: { getRandomValues?: unknown } };
  if (!g.crypto?.getRandomValues) {
    g.crypto = webcrypto as unknown as typeof globalThis.crypto;
  }
});

function fixture(overrides: Partial<ForkEvent> = {}): ForkEvent {
  return {
    fork_event_id: 7,
    operator_pubkey: 'aa'.repeat(32),
    day_utc: '2026-05-07',
    root_hex_a: '11'.repeat(32),
    root_hex_b: '22'.repeat(32),
    observation_id_a: 1,
    observation_id_b: 2,
    detected_at: 1714759200,
    nostr_event_id: null,
    nostr_published_at: null,
    claim_id: null,
    ...overrides,
  };
}

describe('AEPS §8.5 — Nostr fork event builder', () => {
  it('uses kind 31410', () => {
    const tmpl = buildForkEventTemplate(fixture(), 1714759200);
    expect(tmpl.kind).toBe(31410);
    expect(tmpl.kind).toBe(KIND_AEPS_FORK);
  });

  it('emits NIP-33 d-tag = operator:day', () => {
    const tmpl = buildForkEventTemplate(fixture(), 1);
    const dTag = tmpl.tags.find(t => t[0] === 'd');
    expect(dTag).toEqual(['d', 'aa'.repeat(32) + ':2026-05-07']);
  });

  it('emits aeps-fork t-tag', () => {
    const tmpl = buildForkEventTemplate(fixture(), 1);
    expect(tmpl.tags.some(t => t[0] === 't' && t[1] === 'aeps-fork')).toBe(true);
  });

  it('emits op/day/root_a/root_b tags', () => {
    const tmpl = buildForkEventTemplate(fixture(), 1);
    const tagMap = Object.fromEntries(tmpl.tags.map(t => [t[0], t[1]]));
    expect(tagMap.op).toBe('aa'.repeat(32));
    expect(tagMap.day).toBe('2026-05-07');
    expect(tagMap.root_a).toBe('11'.repeat(32));
    expect(tagMap.root_b).toBe('22'.repeat(32));
    expect(tagMap.fork_event_id).toBe('7');
  });

  it('omits nostr_event refs when not provided', () => {
    const tmpl = buildForkEventTemplate(fixture(), 1);
    expect(tmpl.tags.some(t => t[0] === 'nostr_event_a')).toBe(false);
    expect(tmpl.tags.some(t => t[0] === 'nostr_event_b')).toBe(false);
  });

  it('emits nostr_event refs when provided', () => {
    const tmpl = buildForkEventTemplate(fixture(), 1, {
      nostr_event_a: 'aa'.repeat(32),
      nostr_event_b: 'bb'.repeat(32),
    });
    expect(tmpl.tags.some(t => t[0] === 'nostr_event_a' && t[1] === 'aa'.repeat(32))).toBe(true);
    expect(tmpl.tags.some(t => t[0] === 'nostr_event_b' && t[1] === 'bb'.repeat(32))).toBe(true);
  });

  it('signs and produces a valid id + sig', async () => {
    const sk = Buffer.from(randomBytes(32)).toString('hex');
    const tmpl = buildForkEventTemplate(fixture(), 1714759200);
    const signed = await signForkEvent(tmpl, sk);
    expect(signed.kind).toBe(31410);
    expect(signed.id).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(signed.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.tags).toEqual(tmpl.tags);
  });

  it('different forks produce different ids', async () => {
    const sk = Buffer.from(randomBytes(32)).toString('hex');
    const a = await signForkEvent(buildForkEventTemplate(fixture({ root_hex_b: '22'.repeat(32) }), 1), sk);
    const b = await signForkEvent(buildForkEventTemplate(fixture({ root_hex_b: '33'.repeat(32) }), 1), sk);
    expect(a.id).not.toBe(b.id);
  });
});
