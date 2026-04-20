// Phase 7 — tests unitaires des 3 preuves de vérification operator.
//
// Les trois fonctions sont testées indépendamment. Pour NIP-05 et DNS on
// injecte un fetcher/resolver stub pour garder les tests hermétiques ; pour
// LN on signe de vraies signatures via @noble/curves en mémoire.
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto: unknown }).crypto = webcrypto;
}
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  buildLnChallenge,
  verifyLnPubkeyOwnership,
  verifyNip05Ownership,
  verifyDnsOwnership,
} from '../services/operatorVerificationService';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('buildLnChallenge', () => {
  it('produit un challenge versionné déterministe', () => {
    expect(buildLnChallenge('op-abc')).toBe('satrank-operator-claim:v1:op-abc');
  });
});

describe('verifyLnPubkeyOwnership', () => {
  // On génère une paire de clés de test et on signe le challenge canonique.
  // Ces clés ne sont pas stockées — elles vivent uniquement pour le test.
  const { secretKey, publicKey } = secp256k1.keygen();
  const pubkeyHex = bytesToHex(publicKey);
  const operatorId = 'op-alice';
  const challenge = buildLnChallenge(operatorId);
  const challengeBytes = new TextEncoder().encode(challenge);
  const sig = secp256k1.sign(challengeBytes, secretKey); // compact format by default (64 bytes)
  const sigHex = bytesToHex(sig);

  it('accepte une signature ECDSA valide sur le challenge canonique', () => {
    const res = verifyLnPubkeyOwnership(pubkeyHex, operatorId, sigHex);
    expect(res.valid).toBe(true);
  });

  it('rejette une signature pour un autre operator_id (bad_signature)', () => {
    const res = verifyLnPubkeyOwnership(pubkeyHex, 'op-mallory', sigHex);
    expect(res.valid).toBe(false);
    expect(res.detail).toBe('bad_signature');
  });

  it('rejette une signature signée par une autre clé (bad_signature)', () => {
    const other = secp256k1.keygen();
    const otherSig = secp256k1.sign(challengeBytes, other.secretKey);
    const res = verifyLnPubkeyOwnership(pubkeyHex, operatorId, bytesToHex(otherSig));
    expect(res.valid).toBe(false);
    expect(res.detail).toBe('bad_signature');
  });

  it('rejette un pubkey mal formé', () => {
    expect(verifyLnPubkeyOwnership('not-hex', operatorId, sigHex).detail).toBe('pubkey_invalid_format');
    expect(verifyLnPubkeyOwnership(pubkeyHex.slice(0, 64), operatorId, sigHex).detail).toBe('pubkey_invalid_format');
  });

  it('rejette un operator_id vide ou trop long', () => {
    expect(verifyLnPubkeyOwnership(pubkeyHex, '', sigHex).detail).toBe('operator_id_invalid');
    expect(verifyLnPubkeyOwnership(pubkeyHex, 'x'.repeat(200), sigHex).detail).toBe('operator_id_invalid');
  });

  it('rejette une signature hex invalide (hex_decode_failed)', () => {
    expect(verifyLnPubkeyOwnership(pubkeyHex, operatorId, 'XYZ').detail).toBe('hex_decode_failed');
  });

  it('rejette une signature compacte tronquée', () => {
    const res = verifyLnPubkeyOwnership(pubkeyHex, operatorId, sigHex.slice(0, 60));
    expect(res.valid).toBe(false);
    // Soit bad_signature, soit verify_threw — dans les deux cas valid=false
    expect(res.detail).toMatch(/bad_signature|verify_threw|hex_decode_failed/);
  });
});

describe('verifyNip05Ownership', () => {
  const pubkey = 'a'.repeat(64);
  const otherPubkey = 'b'.repeat(64);

  it('accepte un name@domain résolvant au bon pubkey', async () => {
    const fetcher = async () => ({ names: { alice: pubkey } });
    const res = await verifyNip05Ownership('alice@example.com', pubkey, fetcher);
    expect(res.valid).toBe(true);
  });

  it('accepte un name insensible à la casse (lookup par nameKey)', async () => {
    const fetcher = async () => ({ names: { alice: pubkey } });
    const res = await verifyNip05Ownership('Alice@example.com', pubkey, fetcher);
    expect(res.valid).toBe(true);
  });

  it('rejette quand le pubkey NIP-05 diffère (pubkey_mismatch)', async () => {
    const fetcher = async () => ({ names: { alice: otherPubkey } });
    const res = await verifyNip05Ownership('alice@example.com', pubkey, fetcher);
    expect(res.valid).toBe(false);
    expect(res.detail).toBe('pubkey_mismatch');
  });

  it('rejette quand le name n\'est pas dans la réponse (name_not_found)', async () => {
    const fetcher = async () => ({ names: { bob: pubkey } });
    const res = await verifyNip05Ownership('alice@example.com', pubkey, fetcher);
    expect(res.detail).toBe('name_not_found');
  });

  it('rejette quand fetch échoue (fetch_failed)', async () => {
    const fetcher = async () => null;
    const res = await verifyNip05Ownership('alice@example.com', pubkey, fetcher);
    expect(res.detail).toBe('fetch_failed');
  });

  it('rejette un format NIP-05 invalide', async () => {
    const fetcher = async () => ({ names: { alice: pubkey } });
    const res = await verifyNip05Ownership('not-an-address', pubkey, fetcher);
    expect(res.detail).toBe('nip05_invalid_format');
  });

  it('rejette un pubkey de format invalide', async () => {
    const fetcher = async () => ({ names: { alice: pubkey } });
    const res = await verifyNip05Ownership('alice@example.com', 'short', fetcher);
    expect(res.detail).toBe('pubkey_invalid_format');
  });

  it('rejette quand names est manquant ou non-object', async () => {
    const fetcher = async () => ({ other: 'field' });
    const res = await verifyNip05Ownership('alice@example.com', pubkey, fetcher);
    expect(res.detail).toBe('names_missing');
  });
});

describe('verifyDnsOwnership', () => {
  const opId = 'op-abc-123';

  it('accepte un TXT record exact satrank-operator=<id>', async () => {
    const resolver = async () => [[`satrank-operator=${opId}`]];
    const res = await verifyDnsOwnership('example.com', opId, resolver);
    expect(res.valid).toBe(true);
  });

  it('reconstruit les chunks RFC1035 avant comparaison', async () => {
    const full = `satrank-operator=${opId}`;
    const resolver = async () => [[full.slice(0, 10), full.slice(10)]];
    const res = await verifyDnsOwnership('example.com', opId, resolver);
    expect(res.valid).toBe(true);
  });

  it('accepte une entrée parmi plusieurs', async () => {
    const resolver = async () => [
      ['random-other-record'],
      [`satrank-operator=${opId}`],
      ['v=spf1 -all'],
    ];
    const res = await verifyDnsOwnership('example.com', opId, resolver);
    expect(res.valid).toBe(true);
  });

  it('rejette quand aucun record ne matche (no_matching_record)', async () => {
    const resolver = async () => [['satrank-operator=op-other']];
    const res = await verifyDnsOwnership('example.com', opId, resolver);
    expect(res.detail).toBe('no_matching_record');
  });

  it('rejette quand aucun TXT n\'existe (no_txt_record)', async () => {
    const resolver = async () => [];
    const res = await verifyDnsOwnership('example.com', opId, resolver);
    expect(res.detail).toBe('no_txt_record');
  });

  it('rejette un domaine invalide', async () => {
    const resolver = async () => [[`satrank-operator=${opId}`]];
    const res = await verifyDnsOwnership('bad domain!', opId, resolver);
    expect(res.detail).toBe('domain_invalid');
  });

  it('rejette un operator_id vide', async () => {
    const resolver = async () => [[`satrank-operator=${opId}`]];
    const res = await verifyDnsOwnership('example.com', '', resolver);
    expect(res.detail).toBe('operator_id_invalid');
  });

  it('rejette un TXT prefix correct mais operator_id différent', async () => {
    const resolver = async () => [['satrank-operator=op-intruder']];
    const res = await verifyDnsOwnership('example.com', opId, resolver);
    expect(res.valid).toBe(false);
  });
});
