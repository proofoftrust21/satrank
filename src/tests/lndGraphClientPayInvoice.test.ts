// Tests for HttpLndGraphClient.payInvoice() — LND REST base64 encoding.
//
// The Phase 9 /api/probe post-merge sanity check caught a real prod bug:
// LND's /v1/channels/transactions returns payment_preimage and payment_hash
// as base64 strings (the LND REST convention), but the L402 spec requires
// the preimage to be sent as lowercase hex in the Authorization header of
// the retry request. Without decoding, the upstream server rejects the
// retry with "Invalid preimage — payment not verified".
//
// These tests mock the fetch call and assert that the client returns hex,
// so any future regression (e.g. reverting to the raw base64 value) is
// caught in CI instead of in prod.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { HttpLndGraphClient } from '../crawler/lndGraphClient';

function makeTempMacaroon(bytes: Buffer = Buffer.from('aa', 'hex')): string {
  const p = path.join(os.tmpdir(), `lnd-test-${Math.random().toString(36).slice(2)}.macaroon`);
  fs.writeFileSync(p, bytes);
  return p;
}

describe('HttpLndGraphClient.payInvoice — LND REST base64 decoding', () => {
  let roPath: string;
  let adminPath: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    roPath = makeTempMacaroon();
    adminPath = makeTempMacaroon();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    try { fs.unlinkSync(roPath); } catch { /* ignore */ }
    try { fs.unlinkSync(adminPath); } catch { /* ignore */ }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockPayResponse(body: Record<string, string>) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response) as unknown as typeof globalThis.fetch;
  }

  it('decodes payment_preimage and payment_hash from base64 to lowercase hex', async () => {
    // Fixture drawn from a real LND response captured during Phase 9
    // sanity check on prod (2026-04-20). The L402 retry failed because
    // the client returned these values verbatim.
    const preimageB64 = 'gnRG5EwghqUWAfbn+lqzd3JQ1xwjQ5HeZoDZ1/foipk=';
    const hashB64 = 'EG+wKC1LYQIFHZt5S9YgowgogqvcjczPs8t1NmOKUF0=';
    const expectedPreimageHex = Buffer.from(preimageB64, 'base64').toString('hex');
    const expectedHashHex = Buffer.from(hashB64, 'base64').toString('hex');

    mockPayResponse({ payment_preimage: preimageB64, payment_hash: hashB64 });

    const client = new HttpLndGraphClient({
      restUrl: 'https://127.0.0.1:8080',
      macaroonPath: roPath,
      adminMacaroonPath: adminPath,
      timeoutMs: 5000,
    });

    const result = await client.payInvoice('lnbc1...', 10);

    // Shape
    expect(result.paymentError).toBeUndefined();
    // Hex format: lowercase [0-9a-f], length 64 chars (32 bytes)
    expect(result.paymentPreimage).toMatch(/^[0-9a-f]+$/);
    expect(result.paymentPreimage).toHaveLength(64);
    expect(result.paymentHash).toMatch(/^[0-9a-f]+$/);
    expect(result.paymentHash).toHaveLength(64);
    // Exact round-trip
    expect(result.paymentPreimage).toBe(expectedPreimageHex);
    expect(result.paymentHash).toBe(expectedHashHex);
  });

  it('round-trips a random 32-byte preimage base64 → hex correctly', async () => {
    const raw = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) raw[i] = (i * 7 + 3) & 0xff;
    const b64 = raw.toString('base64');
    const hashRaw = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) hashRaw[i] = (i * 11 + 5) & 0xff;
    const hashB64 = hashRaw.toString('base64');

    mockPayResponse({ payment_preimage: b64, payment_hash: hashB64 });

    const client = new HttpLndGraphClient({
      restUrl: 'https://127.0.0.1:8080',
      macaroonPath: roPath,
      adminMacaroonPath: adminPath,
      timeoutMs: 5000,
    });

    const result = await client.payInvoice('lnbc1...', 10);
    expect(result.paymentPreimage).toBe(raw.toString('hex'));
    expect(result.paymentHash).toBe(hashRaw.toString('hex'));
  });

  it('returns empty strings when LND returns payment_error and skips decoding', async () => {
    mockPayResponse({ payment_error: 'no_route' });

    const client = new HttpLndGraphClient({
      restUrl: 'https://127.0.0.1:8080',
      macaroonPath: roPath,
      adminMacaroonPath: adminPath,
      timeoutMs: 5000,
    });

    const result = await client.payInvoice('lnbc1...', 10);
    expect(result.paymentError).toBe('no_route');
    expect(result.paymentPreimage).toBe('');
    expect(result.paymentHash).toBe('');
  });

  it('returns empty strings gracefully when payment_preimage / payment_hash are absent', async () => {
    mockPayResponse({});

    const client = new HttpLndGraphClient({
      restUrl: 'https://127.0.0.1:8080',
      macaroonPath: roPath,
      adminMacaroonPath: adminPath,
      timeoutMs: 5000,
    });

    const result = await client.payInvoice('lnbc1...', 10);
    expect(result.paymentPreimage).toBe('');
    expect(result.paymentHash).toBe('');
  });

  it('returns explicit error when admin macaroon is missing', async () => {
    const client = new HttpLndGraphClient({
      restUrl: 'https://127.0.0.1:8080',
      macaroonPath: roPath,
      // no adminMacaroonPath
      timeoutMs: 5000,
    });

    const result = await client.payInvoice('lnbc1...', 10);
    expect(result.paymentError).toContain('admin macaroon not loaded');
    expect(result.paymentPreimage).toBe('');
  });
});
