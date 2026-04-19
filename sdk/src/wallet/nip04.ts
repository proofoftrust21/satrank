// NIP-04 codec + secp256k1 helpers, built on node:crypto so the SDK stays
// zero-runtime-deps. Schnorr signing (BIP-340) is pluggable because Node has
// no built-in for it — callers wire nostr-tools or @noble/curves via the
// NwcSigner interface. ECDH / AES-CBC / SHA-256 are all native, though.

import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  randomBytes,
} from 'node:crypto';

/** Derive the NIP-04 shared secret: the X coord of ECDH(priv, pub).
 *  `walletPubkeyHex` is x-only (32 bytes / 64 chars) per Nostr convention.
 *  We synthesise the compressed form (prefix 02 — even-Y) for ECDH. */
export function deriveSharedSecret(
  privateKeyHex: string,
  xOnlyPubKeyHex: string,
): Buffer {
  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.from(privateKeyHex, 'hex'));
  const compressed = Buffer.concat([
    Buffer.from([0x02]),
    Buffer.from(xOnlyPubKeyHex, 'hex'),
  ]);
  // computeSecret returns the 32-byte X coord — exactly what NIP-04 wants.
  return ecdh.computeSecret(compressed);
}

/** Derive the x-only public key (32 bytes hex) from a secp256k1 private key. */
export function derivePublicKeyXOnly(privateKeyHex: string): string {
  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.from(privateKeyHex, 'hex'));
  const uncompressed = ecdh.getPublicKey();
  // 65 bytes: 0x04 || X(32) || Y(32). Take X.
  return uncompressed.subarray(1, 33).toString('hex');
}

/** Encrypt a UTF-8 string with AES-256-CBC and append the base64 IV.
 *  Output format (Nostr-canonical): "<cipher_b64>?iv=<iv_b64>". */
export function nip04Encrypt(plaintext: string, sharedSecret: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', sharedSecret, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return `${encrypted.toString('base64')}?iv=${iv.toString('base64')}`;
}

export function nip04Decrypt(
  ciphertext: string,
  sharedSecret: Buffer,
): string {
  const parts = ciphertext.split('?iv=');
  if (parts.length !== 2) {
    throw new Error('NIP-04: malformed ciphertext (missing ?iv=)');
  }
  const [cipherB64, ivB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  if (iv.length !== 16) {
    throw new Error('NIP-04: invalid IV length');
  }
  const decipher = createDecipheriv('aes-256-cbc', sharedSecret, iv);
  return Buffer.concat([
    decipher.update(Buffer.from(cipherB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
