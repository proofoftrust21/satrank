// SDK 1.6 — AEPS helper functions (zero-dep canonical-bytes builders).
// These tests reuse the same fixtures the conformance suite uses to
// guarantee server / TS SDK / Python SDK / Rust ref impl all agree.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildOutcomeMessage,
  buildOutcomeMessageHash,
  buildNip98EventTemplate,
  encodeNip98AuthHeader,
} from '../src/aeps';

describe('AEPS §10 outcome message helpers', () => {
  it('matches spec/test-vectors/dispute_outcome.json', () => {
    const fixture = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', 'spec', 'test-vectors', 'dispute_outcome.json'),
        'utf8',
      ),
    ) as {
      vectors: Array<{
        name: string;
        dispute_id: string;
        outcome: 'disputant_wins' | 'respondent_wins';
        expected_canonical: string;
        expected_hash_hex: string;
      }>;
    };
    for (const v of fixture.vectors) {
      const canonical = buildOutcomeMessage(v.dispute_id, v.outcome);
      expect(canonical).toBe(v.expected_canonical);
      const { hashHex } = buildOutcomeMessageHash(v.dispute_id, v.outcome);
      expect(hashHex).toBe(v.expected_hash_hex);
    }
  });

  it('hashBytes is exactly 32 bytes', () => {
    const r = buildOutcomeMessageHash('dis_test', 'disputant_wins');
    expect(r.hashBytes.length).toBe(32);
  });

  it('different outcomes produce different hashes', () => {
    const a = buildOutcomeMessageHash('dis_x', 'disputant_wins');
    const b = buildOutcomeMessageHash('dis_x', 'respondent_wins');
    expect(a.hashHex).not.toBe(b.hashHex);
  });

  it('different dispute_ids produce different hashes', () => {
    const a = buildOutcomeMessageHash('dis_a', 'disputant_wins');
    const b = buildOutcomeMessageHash('dis_b', 'disputant_wins');
    expect(a.hashHex).not.toBe(b.hashHex);
  });
});

describe('NIP-98 event template helpers', () => {
  it('builds a kind 27235 template with u + method tags', () => {
    const tmpl = buildNip98EventTemplate({
      url: 'https://api.test/api/aeps/dispute',
      method: 'POST',
      createdAt: 1700000000,
    });
    expect(tmpl.kind).toBe(27235);
    expect(tmpl.created_at).toBe(1700000000);
    expect(tmpl.content).toBe('');
    expect(tmpl.tags).toContainEqual(['u', 'https://api.test/api/aeps/dispute']);
    expect(tmpl.tags).toContainEqual(['method', 'POST']);
  });

  it('omits payload tag when body is null/empty', () => {
    const t1 = buildNip98EventTemplate({
      url: 'https://x/y',
      method: 'GET',
      createdAt: 1,
    });
    const t2 = buildNip98EventTemplate({
      url: 'https://x/y',
      method: 'GET',
      body: '',
      createdAt: 1,
    });
    expect(t1.tags.some(t => t[0] === 'payload')).toBe(false);
    expect(t2.tags.some(t => t[0] === 'payload')).toBe(false);
  });

  it('emits payload tag = sha256 hex of body string', () => {
    const tmpl = buildNip98EventTemplate({
      url: 'https://x/y',
      method: 'POST',
      body: '{"hello":"world"}',
      createdAt: 1,
    });
    const payloadTag = tmpl.tags.find(t => t[0] === 'payload');
    expect(payloadTag).toBeDefined();
    // sha256("{"hello":"world"}") = 93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588
    expect(payloadTag![1]).toBe('93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588');
  });

  it('emits payload tag = sha256 hex of body Buffer', () => {
    const buf = Buffer.from('{"hello":"world"}', 'utf8');
    const tmpl = buildNip98EventTemplate({
      url: 'https://x/y',
      method: 'POST',
      body: buf,
      createdAt: 1,
    });
    const payloadTag = tmpl.tags.find(t => t[0] === 'payload');
    expect(payloadTag![1]).toBe('93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588');
  });

  it('defaults created_at to now when omitted', () => {
    const before = Math.floor(Date.now() / 1000);
    const tmpl = buildNip98EventTemplate({ url: 'https://x', method: 'GET' });
    const after = Math.floor(Date.now() / 1000);
    expect(tmpl.created_at).toBeGreaterThanOrEqual(before);
    expect(tmpl.created_at).toBeLessThanOrEqual(after);
  });
});

describe('encodeNip98AuthHeader', () => {
  it('produces "Nostr <base64-event>"', () => {
    const signed = {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      kind: 27235,
      created_at: 1700000000,
      tags: [['u', 'https://x'], ['method', 'GET']],
      content: '',
      sig: 'c'.repeat(128),
    };
    const auth = encodeNip98AuthHeader(signed);
    expect(auth.startsWith('Nostr ')).toBe(true);
    const b64 = auth.slice('Nostr '.length);
    const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    expect(decoded).toEqual(signed);
  });
});
