#!/usr/bin/env npx tsx
// Generate a Nostr keypair for SatRank event publishing
// Usage: npx tsx scripts/nostr-keygen.ts
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils';
// @ts-expect-error — ESM subpath
import { npubEncode } from 'nostr-tools/nip19';

const sk = generateSecretKey();
const skHex = bytesToHex(sk);
const pk = getPublicKey(sk);
const npub = npubEncode(pk);

console.log('=== SatRank Nostr Keypair ===');
console.log(`Private key (hex): ${skHex}`);
console.log(`Public key  (hex): ${pk}`);
console.log(`Public key (npub): ${npub}`);
console.log('');
console.log('Add to .env.production:');
console.log(`NOSTR_PRIVATE_KEY=${skHex}`);
