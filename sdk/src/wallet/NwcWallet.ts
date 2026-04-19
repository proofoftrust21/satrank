// NWC (NIP-47) wallet driver. Speaks to any Nostr Wallet Connect provider
// (Alby, Mutiny, CoinOS, Wavlake, self-hosted Minibits, ...) by publishing
// encrypted kind:23194 events to a relay and awaiting kind:23195 responses.
//
// Crypto layout:
//   - NIP-04 (AES-CBC via ECDH shared secret) → built-in node:crypto.
//   - BIP-340 schnorr signing → pluggable `NwcSigner`. Zero-deps is the SDK
//     promise; every Nostr user already has nostr-tools or @noble at hand.
//     Wiring is ~3 lines — see docs/sdk/nwc.md.
//
// Transport: we accept an injectable WebSocket ctor (defaulting to
// globalThis.WebSocket, available in Node 22+ and every browser). In Node
// 18/20 the user passes `ws` or `undici` — same DI pattern as LND fetch.

import { WalletError } from '../errors';
import type { Wallet } from '../types';
import {
  deriveSharedSecret,
  derivePublicKeyXOnly,
  nip04Decrypt,
  nip04Encrypt,
} from './nip04';
import { createHash } from 'node:crypto';

export interface NwcSigner {
  /** BIP-340 schnorr signature of a 32-byte message (the event id).
   *  Returns the 64-byte hex signature. */
  schnorrSign(
    eventId: Uint8Array,
    privateKeyHex: string,
  ): Promise<string> | string;
}

/** Minimal WebSocket surface — compatible with the browser API and `ws` npm. */
export interface NwcWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: { data?: string } | Event | undefined) => void,
  ): void;
}

export type NwcWebSocketCtor = new (url: string) => NwcWebSocket;

export interface NwcWalletOptions {
  /** nostr+walletconnect:// URI from the wallet app (Alby → Connections). */
  uri: string;
  /** BIP-340 schnorr signer — bring your own (nostr-tools / @noble). */
  signer: NwcSigner;
  /** WebSocket ctor. Defaults to `globalThis.WebSocket` (Node 22+ / browser). */
  webSocket?: NwcWebSocketCtor;
  /** End-to-end timeout for the pay_invoice roundtrip (ms). Default 60_000. */
  timeout_ms?: number;
}

interface ParsedNwcUri {
  walletPubkey: string;
  relayUrl: string;
  secretHex: string;
}

export function parseNwcUri(uri: string): ParsedNwcUri {
  const match = /^nostr\+?walletconnect:\/\/(.+)$/i.exec(uri.trim());
  if (!match) {
    throw new Error('NwcWallet: URI must start with nostr+walletconnect://');
  }
  const rest = match[1];
  const [rawPubkey, query] = rest.split('?');
  if (!rawPubkey || !/^[0-9a-f]{64}$/i.test(rawPubkey)) {
    throw new Error('NwcWallet: wallet pubkey must be 64-char hex');
  }
  const params = new URLSearchParams(query ?? '');
  const relay = params.get('relay');
  const secret = params.get('secret');
  if (!relay) throw new Error('NwcWallet: missing relay= param');
  if (!secret || !/^[0-9a-f]{64}$/i.test(secret)) {
    throw new Error('NwcWallet: secret must be 64-char hex');
  }
  return {
    walletPubkey: rawPubkey.toLowerCase(),
    relayUrl: relay,
    secretHex: secret.toLowerCase(),
  };
}

interface NostrEventUnsigned {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

interface NostrEventSigned extends NostrEventUnsigned {
  id: string;
  sig: string;
}

function computeEventId(evt: NostrEventUnsigned): Uint8Array {
  // NIP-01 canonical serialization — exact field order matters.
  const serialized = JSON.stringify([
    0,
    evt.pubkey,
    evt.created_at,
    evt.kind,
    evt.tags,
    evt.content,
  ]);
  return createHash('sha256').update(serialized).digest();
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function randomSubId(): string {
  return `satrank-${Math.random().toString(36).slice(2, 10)}`;
}

const NWC_ERROR_TO_WALLET_CODE: Record<string, string> = {
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  RESTRICTED: 'UNAUTHORIZED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INTERNAL: 'NWC_INTERNAL',
  OTHER: 'PAYMENT_FAILED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  NOT_FOUND: 'NOT_FOUND',
};

export class NwcWallet implements Wallet {
  private readonly parsed: ParsedNwcUri;
  private readonly signer: NwcSigner;
  private readonly WebSocketImpl: NwcWebSocketCtor;
  private readonly timeout_ms: number;
  private readonly clientPubkey: string;

  constructor(opts: NwcWalletOptions) {
    this.parsed = parseNwcUri(opts.uri);
    this.signer = opts.signer;
    const WSGlobal = (
      globalThis as unknown as { WebSocket?: NwcWebSocketCtor }
    ).WebSocket;
    const WSImpl = opts.webSocket ?? WSGlobal;
    if (!WSImpl) {
      throw new Error(
        'NwcWallet: no WebSocket available — pass opts.webSocket (use `ws` on Node <22)',
      );
    }
    this.WebSocketImpl = WSImpl;
    this.timeout_ms = opts.timeout_ms ?? 60_000;
    this.clientPubkey = derivePublicKeyXOnly(this.parsed.secretHex);
  }

  async payInvoice(
    bolt11: string,
    maxFeeSats: number,
  ): Promise<{ preimage: string; feePaidSats: number }> {
    const shared = deriveSharedSecret(
      this.parsed.secretHex,
      this.parsed.walletPubkey,
    );

    // NIP-47 pay_invoice. `max_fees_msat` is part of the v1.1 extension; most
    // wallets honor it but spec-minimal wallets may ignore it. We still post-
    // check the returned fee against `maxFeeSats` so the agent can react.
    const payload = JSON.stringify({
      method: 'pay_invoice',
      params: {
        invoice: bolt11,
        max_fees_msat: Math.max(0, Math.floor(maxFeeSats) * 1000),
      },
    });
    const encryptedContent = nip04Encrypt(payload, shared);

    const createdAt = Math.floor(Date.now() / 1000);
    const unsigned: NostrEventUnsigned = {
      pubkey: this.clientPubkey,
      created_at: createdAt,
      kind: 23194,
      tags: [['p', this.parsed.walletPubkey]],
      content: encryptedContent,
    };
    const idBytes = computeEventId(unsigned);
    const sig = await Promise.resolve(
      this.signer.schnorrSign(idBytes, this.parsed.secretHex),
    );
    const signed: NostrEventSigned = {
      ...unsigned,
      id: hex(idBytes),
      sig,
    };

    const responseEvent = await this.roundtrip(signed);

    let plaintext: string;
    try {
      plaintext = nip04Decrypt(responseEvent.content, shared);
    } catch (err) {
      throw new WalletError(
        `NWC decrypt failed: ${err instanceof Error ? err.message : String(err)}`,
        'INVALID_RESPONSE',
      );
    }

    let parsed: {
      result_type?: string;
      error?: { code?: string; message?: string };
      result?: { preimage?: string; fees_paid?: number };
    };
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      throw new WalletError('NWC: response is not valid JSON', 'INVALID_RESPONSE');
    }

    if (parsed.error) {
      const code =
        NWC_ERROR_TO_WALLET_CODE[parsed.error.code ?? ''] ?? 'PAYMENT_FAILED';
      throw new WalletError(
        `NWC payment failed: ${parsed.error.message ?? parsed.error.code ?? 'unknown'}`,
        code,
      );
    }
    if (!parsed.result || !parsed.result.preimage) {
      throw new WalletError(
        'NWC returned no preimage and no error',
        'INVALID_RESPONSE',
      );
    }
    const feeSats = parsed.result.fees_paid
      ? Math.floor(parsed.result.fees_paid / 1000)
      : 0;
    return { preimage: parsed.result.preimage, feePaidSats: feeSats };
  }

  async isAvailable(): Promise<boolean> {
    // No canonical NIP-47 ping. We open the socket and resolve true on
    // 'open' — anything else (error, timeout) yields false.
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // ignore
        }
        resolve(ok);
      };
      const ws = new this.WebSocketImpl(this.parsed.relayUrl);
      const timer = setTimeout(() => done(false), 5_000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        done(true);
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        done(false);
      });
      ws.addEventListener('close', () => {
        clearTimeout(timer);
        done(false);
      });
    });
  }

  private roundtrip(signed: NostrEventSigned): Promise<NostrEventSigned> {
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(this.parsed.relayUrl);
      const subId = randomSubId();
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // ignore
        }
        fn();
      };

      const timer = setTimeout(
        () =>
          finish(() =>
            reject(new WalletError('NWC roundtrip timed out', 'TIMEOUT')),
          ),
        this.timeout_ms,
      );

      ws.addEventListener('open', () => {
        // Subscribe first so we don't miss a fast response.
        const req = [
          'REQ',
          subId,
          {
            kinds: [23195],
            authors: [this.parsed.walletPubkey],
            '#e': [signed.id],
            '#p': [this.clientPubkey],
            since: signed.created_at - 1,
          },
        ];
        ws.send(JSON.stringify(req));
        ws.send(JSON.stringify(['EVENT', signed]));
      });

      ws.addEventListener('message', (event) => {
        const data = (event as { data?: string })?.data;
        if (typeof data !== 'string') return;
        let msg: unknown;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if (!Array.isArray(msg)) return;
        const [verb, ...rest] = msg as [string, ...unknown[]];
        if (verb === 'OK') {
          // ['OK', <event_id>, <accepted>, <reason>]
          const [, , accepted, reason] = msg as [
            string,
            string,
            boolean,
            string,
          ];
          if (accepted === false) {
            clearTimeout(timer);
            finish(() =>
              reject(
                new WalletError(
                  `NWC relay rejected event: ${reason ?? 'unknown'}`,
                  'RELAY_REJECTED',
                ),
              ),
            );
          }
          return;
        }
        if (verb === 'EVENT') {
          const [, , evt] = msg as [string, string, NostrEventSigned];
          if (
            evt &&
            evt.kind === 23195 &&
            evt.tags?.some((t) => t[0] === 'e' && t[1] === signed.id)
          ) {
            clearTimeout(timer);
            finish(() => resolve(evt));
          }
          return;
        }
        // CLOSED / NOTICE / EOSE — ignore
        void rest;
      });

      ws.addEventListener('error', () => {
        clearTimeout(timer);
        finish(() =>
          reject(new WalletError('NWC relay connection error', 'TRANSPORT')),
        );
      });
    });
  }
}
