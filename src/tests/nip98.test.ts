// NIP-98 verifier tests — specifically covers audit C1 (rawBody binding must
// be enforced for POST/PUT/PATCH) and H3 adjacency (URL mismatch).
import { webcrypto } from 'node:crypto';
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto: unknown }).crypto = webcrypto;
}
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { verifyNip98, __resetNip98ReplayCacheForTests } from '../middleware/nip98';
// @ts-expect-error — ESM subpath
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

/** Build a signed NIP-98 event for the given attributes. */
function signEvent(opts: {
  url: string;
  method: string;
  body?: string;
  createdAtOverride?: number;
  kindOverride?: number;
  payloadOverride?: string | null;
}): { event: { pubkey: string; serialized: string }; authHeader: string } {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  const tags: string[][] = [
    ['u', opts.url],
    ['method', opts.method],
  ];
  if (opts.body && opts.body.length > 0 && opts.payloadOverride !== null) {
    const hash = opts.payloadOverride ?? crypto.createHash('sha256').update(opts.body, 'utf8').digest('hex');
    tags.push(['payload', hash]);
  } else if (opts.payloadOverride) {
    tags.push(['payload', opts.payloadOverride]);
  }
  const template = {
    kind: opts.kindOverride ?? 27235,
    created_at: opts.createdAtOverride ?? Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
  const signed = finalizeEvent(template, sk);
  const base64 = Buffer.from(JSON.stringify(signed)).toString('base64');
  return { event: { pubkey, serialized: JSON.stringify(signed) }, authHeader: `Nostr ${base64}` };
}

const URL_OK = 'https://satrank.dev/api/report';

describe('verifyNip98', () => {
  beforeEach(() => {
    // Audit Tier 2F — wipe the in-process replay cache so tests stay isolated.
    // Without this, the replay cases pollute later cases that re-use the same
    // signed event.
    __resetNip98ReplayCacheForTests();
  });

  it('accepts a POST with matching body + payload tag', async () => {
    const body = JSON.stringify({ target: 'abc' });
    const { authHeader } = signEvent({ url: URL_OK, method: 'POST', body });
    const result = await verifyNip98(authHeader, 'POST', URL_OK, Buffer.from(body, 'utf8'));
    expect(result.valid).toBe(true);
  });

  // --- audit C1: body binding must be enforced ---
  it('REJECTS a POST when rawBody is null (C1: caller bug must not silently pass)', async () => {
    const body = JSON.stringify({ target: 'abc' });
    const { authHeader } = signEvent({ url: URL_OK, method: 'POST', body });
    const result = await verifyNip98(authHeader, 'POST', URL_OK, null);
    expect(result.valid).toBe(false);
    // Public reason collapses to 'invalid' (audit M2); diagnostic in `detail`.
    expect(result.reason).toBe('invalid');
    expect(result.detail).toBe('rawbody_not_captured');
  });

  it('REJECTS a POST with body but no payload tag on the event (C1: cannot verify intent)', async () => {
    const body = JSON.stringify({ target: 'abc' });
    // Force the signer to omit the payload tag on a body-carrying method
    const { authHeader } = signEvent({ url: URL_OK, method: 'POST', body, payloadOverride: null });
    const result = await verifyNip98(authHeader, 'POST', URL_OK, Buffer.from(body, 'utf8'));
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid');
    expect(result.detail).toBe('payload_missing');
  });

  it('REJECTS a POST where the payload hash does not match the actual body (C1)', async () => {
    const signedBody = JSON.stringify({ target: 'a' });
    const { authHeader } = signEvent({ url: URL_OK, method: 'POST', body: signedBody });
    const attackBody = JSON.stringify({ target: 'EVIL' }); // different from what was signed
    const result = await verifyNip98(authHeader, 'POST', URL_OK, Buffer.from(attackBody, 'utf8'));
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid');
    expect(result.detail).toBe('payload_mismatch');
  });

  it('accepts an empty-body POST without a payload tag', async () => {
    const { authHeader } = signEvent({ url: URL_OK, method: 'POST', body: '' });
    const result = await verifyNip98(authHeader, 'POST', URL_OK, Buffer.alloc(0));
    expect(result.valid).toBe(true);
  });

  it('rejects a URL mismatch (H3 adjacency)', async () => {
    const body = JSON.stringify({ x: 1 });
    const { authHeader } = signEvent({ url: 'https://evil.com/api/report', method: 'POST', body });
    const result = await verifyNip98(authHeader, 'POST', URL_OK, Buffer.from(body, 'utf8'));
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid');
    expect(result.detail).toBe('url_mismatch');
  });

  it('rejects a stale event (created_at too old)', async () => {
    const body = '';
    const { authHeader } = signEvent({
      url: URL_OK,
      method: 'POST',
      body,
      createdAtOverride: Math.floor(Date.now() / 1000) - 3600,
    });
    const result = await verifyNip98(authHeader, 'POST', URL_OK, Buffer.alloc(0));
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid');
    expect(result.detail).toBe('stale_or_future_event');
  });

  it('rejects the wrong kind', async () => {
    const body = '';
    const { authHeader } = signEvent({ url: URL_OK, method: 'POST', body, kindOverride: 1 });
    const result = await verifyNip98(authHeader, 'POST', URL_OK, Buffer.alloc(0));
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid');
    expect(result.detail).toBe('wrong_kind');
  });

  it('rejects a malformed Authorization header', async () => {
    const result = await verifyNip98('Nostr not-base64!@@', 'POST', URL_OK, Buffer.alloc(0));
    expect(result.valid).toBe(false);
  });

  it('rejects a GET without rawBody requirement (no body-carrying method)', async () => {
    // GET can't carry a body — the body-binding check does not apply. The
    // signature check still runs and with a GET-bound event it should pass.
    const { authHeader } = signEvent({ url: URL_OK, method: 'GET', body: '' });
    const result = await verifyNip98(authHeader, 'GET', URL_OK, null);
    expect(result.valid).toBe(true);
  });

  // --- excellence pass: event_id surfaced for audit-log consumers ---
  it('exposes the parsed event_id on success (audit-log surface)', async () => {
    const body = JSON.stringify({ url: 'https://api.example.com/' });
    const { authHeader } = signEvent({ url: URL_OK, method: 'POST', body });
    const result = await verifyNip98(authHeader, 'POST', URL_OK, Buffer.from(body, 'utf8'));
    expect(result.valid).toBe(true);
    expect(result.event_id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('exposes the parsed event_id even when verification fails after parsing (URL mismatch)', async () => {
    const body = JSON.stringify({ x: 1 });
    const { authHeader } = signEvent({ url: 'https://evil.com/api/report', method: 'POST', body });
    const result = await verifyNip98(authHeader, 'POST', URL_OK, Buffer.from(body, 'utf8'));
    expect(result.valid).toBe(false);
    expect(result.detail).toBe('url_mismatch');
    expect(result.event_id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('event_id is null when the header could not be parsed', async () => {
    const result = await verifyNip98('Nostr not-base64!@@', 'POST', URL_OK, Buffer.alloc(0));
    expect(result.valid).toBe(false);
    expect(result.event_id).toBeNull();
  });

  // --- audit Tier 2F: replay protection ---
  it('rejects a replayed event (same Authorization header twice within the TTL window)', async () => {
    const body = JSON.stringify({ x: 1 });
    const { authHeader } = signEvent({ url: URL_OK, method: 'POST', body });
    const r1 = await verifyNip98(authHeader, 'POST', URL_OK, Buffer.from(body, 'utf8'));
    expect(r1.valid).toBe(true);
    // Second call with the EXACT same signed event = replay attempt.
    const r2 = await verifyNip98(authHeader, 'POST', URL_OK, Buffer.from(body, 'utf8'));
    expect(r2.valid).toBe(false);
    expect(r2.reason).toBe('invalid');
    expect(r2.detail).toBe('replayed_event');
    expect(r2.event_id).toBe(r1.event_id);
  });

  it('does NOT cache failed forgeries (different events still verifiable after a forgery)', async () => {
    // A failed forgery should not consume a replay-cache slot; otherwise
    // an attacker could DoS the cache by sending many bad events.
    const body = JSON.stringify({ x: 1 });
    // First, a forged event with bad signature (URL mismatch) → fails.
    const { authHeader: bad } = signEvent({ url: 'https://evil.com/x', method: 'POST', body });
    const r1 = await verifyNip98(bad, 'POST', URL_OK, Buffer.from(body, 'utf8'));
    expect(r1.valid).toBe(false);
    // Now a legit event for the right URL → should still succeed (the
    // failed forgery did not poison the cache).
    const { authHeader: ok } = signEvent({ url: URL_OK, method: 'POST', body });
    const r2 = await verifyNip98(ok, 'POST', URL_OK, Buffer.from(body, 'utf8'));
    expect(r2.valid).toBe(true);
  });
});
