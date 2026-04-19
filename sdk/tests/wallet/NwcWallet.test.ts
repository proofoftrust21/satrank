// Covers the NWC (NIP-47) driver: URI parsing guardrails, the kind:23194
// request + kind:23195 response roundtrip (with real NIP-04 encryption + a
// fake schnorr signer), error mapping, and timeout. WebSocket is mocked.
import { describe, it, expect } from 'vitest';
import { NwcWallet, parseNwcUri } from '../../src/wallet/NwcWallet';
import type { NwcWebSocketCtor } from '../../src/wallet/NwcWallet';
import {
  derivePublicKeyXOnly,
  deriveSharedSecret,
  nip04Encrypt,
} from '../../src/wallet/nip04';
import { WalletError } from '../../src/errors';

// Two throwaway secp256k1 keys. Real private keys just need to be in curve
// range; 'aa'*32 and 'bb'*32 work — node:crypto validates range on setPrivateKey.
const CLIENT_SECRET =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WALLET_SECRET =
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// Pubkeys derived from the above secrets via real secp256k1 math (node:crypto).
const WALLET_PUBKEY = derivePublicKeyXOnly(WALLET_SECRET);
const CLIENT_PUBKEY = derivePublicKeyXOnly(CLIENT_SECRET);
const RELAY = 'wss://relay.test';

const URI = `nostr+walletconnect://${WALLET_PUBKEY}?relay=${encodeURIComponent(RELAY)}&secret=${CLIENT_SECRET}`;

// Schnorr signature is opaque to the relay mock — any 64-byte hex works.
const stubSigner = {
  schnorrSign: () =>
    '00'.repeat(64),
};

// Minimal event listener store so we can trigger events synchronously.
type AnyListener = (e: unknown) => void;

interface FakeWs {
  readonly url: string;
  closed: boolean;
  listeners: Record<string, AnyListener[]>;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, fn: AnyListener): void;
  emitMessage(data: string): void;
  emitError(): void;
}

function makeFakeWsCtor(
  onSend: (data: string, ws: FakeWs) => void,
): { ctor: NwcWebSocketCtor; instances: FakeWs[] } {
  const instances: FakeWs[] = [];
  class FakeWsImpl implements FakeWs {
    listeners: Record<string, AnyListener[]> = {
      open: [],
      message: [],
      error: [],
      close: [],
    };
    closed = false;
    constructor(public readonly url: string) {
      instances.push(this);
      queueMicrotask(() => {
        if (this.closed) return;
        this.listeners.open.forEach((fn) => fn(undefined));
      });
    }
    send(data: string): void {
      onSend(data, this);
    }
    close(): void {
      this.closed = true;
      this.listeners.close.forEach((fn) => fn(undefined));
    }
    addEventListener(type: string, fn: AnyListener): void {
      (this.listeners[type] ??= []).push(fn);
    }
    emitMessage(data: string): void {
      this.listeners.message.forEach((fn) => fn({ data }));
    }
    emitError(): void {
      this.listeners.error.forEach((fn) => fn(undefined));
    }
  }
  return {
    ctor: FakeWsImpl as unknown as NwcWebSocketCtor,
    instances,
  };
}

describe('parseNwcUri', () => {
  it('parses a canonical URI', () => {
    const p = parseNwcUri(URI);
    expect(p.walletPubkey).toBe(WALLET_PUBKEY);
    expect(p.relayUrl).toBe(RELAY);
    expect(p.secretHex).toBe(CLIENT_SECRET);
  });

  it('rejects a non-NWC URI', () => {
    expect(() => parseNwcUri('https://example.com')).toThrow(
      /nostr\+walletconnect/,
    );
  });

  it('rejects a bad pubkey', () => {
    expect(() =>
      parseNwcUri('nostr+walletconnect://deadbeef?relay=wss://r&secret=' + CLIENT_SECRET),
    ).toThrow(/64-char hex/);
  });

  it('rejects missing relay', () => {
    expect(() =>
      parseNwcUri(`nostr+walletconnect://${WALLET_PUBKEY}?secret=${CLIENT_SECRET}`),
    ).toThrow(/relay/);
  });

  it('rejects a bad secret', () => {
    expect(() =>
      parseNwcUri(`nostr+walletconnect://${WALLET_PUBKEY}?relay=${encodeURIComponent(RELAY)}&secret=xx`),
    ).toThrow(/secret must be 64/);
  });
});

describe('NwcWallet — payInvoice roundtrip', () => {
  it('encrypts request, decrypts response, returns preimage + fee', async () => {
    // The fake relay: when it sees an EVENT frame, it responds with an
    // encrypted kind:23195 tagged with e=<req_id> and result.preimage set.
    const { ctor, instances } = makeFakeWsCtor((data, ws) => {
      const frame = JSON.parse(data);
      if (frame[0] !== 'EVENT') return; // ignore REQ frames
      const reqEvent = frame[1];
      // Ack with OK
      queueMicrotask(() =>
        ws.emitMessage(JSON.stringify(['OK', reqEvent.id, true, ''])),
      );
      // Simulate wallet: build the response, encrypt with shared secret
      const shared = deriveSharedSecret(WALLET_SECRET, CLIENT_PUBKEY);
      const responsePayload = JSON.stringify({
        result_type: 'pay_invoice',
        result: { preimage: 'cafe'.repeat(16), fees_paid: 2000 },
      });
      const responseEvent = {
        id: 'e'.repeat(64),
        pubkey: WALLET_PUBKEY,
        kind: 23195,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', reqEvent.id],
          ['p', CLIENT_PUBKEY],
        ],
        content: nip04Encrypt(responsePayload, shared),
        sig: '00'.repeat(64),
      };
      queueMicrotask(() =>
        ws.emitMessage(JSON.stringify(['EVENT', 'sub-id', responseEvent])),
      );
    });

    const wallet = new NwcWallet({
      uri: URI,
      signer: stubSigner,
      webSocket: ctor,
    });
    const res = await wallet.payInvoice('lnbc1u1test', 10);
    expect(res.preimage).toBe('cafe'.repeat(16));
    expect(res.feePaidSats).toBe(2); // 2000 msat / 1000
    expect(instances).toHaveLength(1);
  });

  it('maps NIP-47 error codes to WalletError codes', async () => {
    const { ctor } = makeFakeWsCtor((data, ws) => {
      const frame = JSON.parse(data);
      if (frame[0] !== 'EVENT') return;
      const reqEvent = frame[1];
      const shared = deriveSharedSecret(WALLET_SECRET, CLIENT_PUBKEY);
      const responsePayload = JSON.stringify({
        result_type: 'pay_invoice',
        error: { code: 'INSUFFICIENT_BALANCE', message: 'broke' },
      });
      queueMicrotask(() =>
        ws.emitMessage(
          JSON.stringify([
            'EVENT',
            'sub-id',
            {
              id: 'e'.repeat(64),
              pubkey: WALLET_PUBKEY,
              kind: 23195,
              created_at: Math.floor(Date.now() / 1000),
              tags: [['e', reqEvent.id]],
              content: nip04Encrypt(responsePayload, shared),
              sig: '00'.repeat(64),
            },
          ]),
        ),
      );
    });
    const wallet = new NwcWallet({
      uri: URI,
      signer: stubSigner,
      webSocket: ctor,
    });
    const err = await wallet.payInvoice('lnbc1u1test', 10).catch((e) => e);
    expect(err).toBeInstanceOf(WalletError);
    expect((err as WalletError).code).toBe('INSUFFICIENT_BALANCE');
  });

  it('maps unknown NIP-47 error code to PAYMENT_FAILED', async () => {
    const { ctor } = makeFakeWsCtor((data, ws) => {
      const frame = JSON.parse(data);
      if (frame[0] !== 'EVENT') return;
      const reqEvent = frame[1];
      const shared = deriveSharedSecret(WALLET_SECRET, CLIENT_PUBKEY);
      const responsePayload = JSON.stringify({
        result_type: 'pay_invoke',
        error: { code: 'MYSTERY', message: 'who knows' },
      });
      queueMicrotask(() =>
        ws.emitMessage(
          JSON.stringify([
            'EVENT',
            'sub-id',
            {
              id: 'e'.repeat(64),
              pubkey: WALLET_PUBKEY,
              kind: 23195,
              created_at: Math.floor(Date.now() / 1000),
              tags: [['e', reqEvent.id]],
              content: nip04Encrypt(responsePayload, shared),
              sig: '00'.repeat(64),
            },
          ]),
        ),
      );
    });
    const wallet = new NwcWallet({
      uri: URI,
      signer: stubSigner,
      webSocket: ctor,
    });
    const err = await wallet.payInvoice('lnbc1u1test', 10).catch((e) => e);
    expect((err as WalletError).code).toBe('PAYMENT_FAILED');
  });

  it('times out when relay never responds with kind:23195', async () => {
    const { ctor } = makeFakeWsCtor((data, ws) => {
      const frame = JSON.parse(data);
      if (frame[0] === 'EVENT') {
        // Ack the send but never deliver a response
        queueMicrotask(() =>
          ws.emitMessage(JSON.stringify(['OK', frame[1].id, true, ''])),
        );
      }
    });
    const wallet = new NwcWallet({
      uri: URI,
      signer: stubSigner,
      webSocket: ctor,
      timeout_ms: 20,
    });
    const err = await wallet.payInvoice('lnbc1u1test', 10).catch((e) => e);
    expect(err).toBeInstanceOf(WalletError);
    expect((err as WalletError).code).toBe('TIMEOUT');
  });

  it('surfaces RELAY_REJECTED when OK=false', async () => {
    const { ctor } = makeFakeWsCtor((data, ws) => {
      const frame = JSON.parse(data);
      if (frame[0] === 'EVENT') {
        queueMicrotask(() =>
          ws.emitMessage(
            JSON.stringify(['OK', frame[1].id, false, 'invalid sig']),
          ),
        );
      }
    });
    const wallet = new NwcWallet({
      uri: URI,
      signer: stubSigner,
      webSocket: ctor,
    });
    const err = await wallet.payInvoice('lnbc1u1test', 10).catch((e) => e);
    expect((err as WalletError).code).toBe('RELAY_REJECTED');
  });

  it('throws INVALID_RESPONSE when decrypt fails', async () => {
    const { ctor } = makeFakeWsCtor((data, ws) => {
      const frame = JSON.parse(data);
      if (frame[0] !== 'EVENT') return;
      const reqEvent = frame[1];
      queueMicrotask(() =>
        ws.emitMessage(
          JSON.stringify([
            'EVENT',
            'sub-id',
            {
              id: 'e'.repeat(64),
              pubkey: WALLET_PUBKEY,
              kind: 23195,
              created_at: Math.floor(Date.now() / 1000),
              tags: [['e', reqEvent.id]],
              content: 'garbage', // malformed, no ?iv=
              sig: '00'.repeat(64),
            },
          ]),
        ),
      );
    });
    const wallet = new NwcWallet({
      uri: URI,
      signer: stubSigner,
      webSocket: ctor,
    });
    const err = await wallet.payInvoice('lnbc1u1test', 10).catch((e) => e);
    expect((err as WalletError).code).toBe('INVALID_RESPONSE');
  });

  it('builds the REQ frame with kinds=[23195] + e-filter + authors=wallet', async () => {
    const sentFrames: unknown[] = [];
    const { ctor } = makeFakeWsCtor((data, ws) => {
      const frame = JSON.parse(data);
      sentFrames.push(frame);
      if (frame[0] === 'EVENT') {
        // Deliver a valid response so the promise resolves and the test finishes.
        const shared = deriveSharedSecret(WALLET_SECRET, CLIENT_PUBKEY);
        queueMicrotask(() =>
          ws.emitMessage(
            JSON.stringify([
              'EVENT',
              'sub-id',
              {
                id: 'e'.repeat(64),
                pubkey: WALLET_PUBKEY,
                kind: 23195,
                created_at: Math.floor(Date.now() / 1000),
                tags: [['e', frame[1].id]],
                content: nip04Encrypt(
                  JSON.stringify({
                    result_type: 'pay_invoice',
                    result: { preimage: 'ab'.repeat(32) },
                  }),
                  shared,
                ),
                sig: '00'.repeat(64),
              },
            ]),
          ),
        );
      }
    });
    const wallet = new NwcWallet({
      uri: URI,
      signer: stubSigner,
      webSocket: ctor,
    });
    await wallet.payInvoice('lnbc1u1test', 10);
    const reqFrame = sentFrames.find(
      (f) => Array.isArray(f) && f[0] === 'REQ',
    ) as [string, string, Record<string, unknown>];
    expect(reqFrame).toBeDefined();
    const filter = reqFrame[2];
    expect(filter.kinds).toEqual([23195]);
    expect(filter.authors).toEqual([WALLET_PUBKEY]);
    expect((filter['#e'] as string[])[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});
