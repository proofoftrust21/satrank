// Phase 7 — vérification cryptographique des identités operator.
//
// Trois preuves indépendantes, chacune vérifiable hors-ligne ou avec un
// appel réseau déterministe. La règle dure du brief : ≥2/3 preuves
// convergentes pour passer status='verified'. Ce fichier fournit les briques
// unitaires ; la logique de combinaison (count ≥ 2) vit dans operatorService.
//
// Aucune des fonctions ne touche la base de données — elles sont pures côté
// cryptographie et testables sans mock DB.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { logger } from '../logger';
import { resolveAndPin } from '../utils/ssrf';

/** Challenge canonique signé par la clé LN de l'operator.
 *  Format explicite + versionné : un changement de version (v2) invalide
 *  toutes les preuves antérieures si jamais le schéma change. */
export function buildLnChallenge(operatorId: string): string {
  return `satrank-operator-claim:v1:${operatorId}`;
}

/** Hex → Uint8Array utilitaire (tolérant au 0x prefix et insensible à la casse). */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('hex length odd');
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error('hex non-hexadécimal');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Résultat commun aux 3 preuves : booléen simple + détail pour logs serveur. */
export interface VerifyResult {
  valid: boolean;
  detail?: string;
}

// ---------------------------------------------------------------------------
// 1. LN pubkey ownership — ECDSA secp256k1 sur un challenge canonique
// ---------------------------------------------------------------------------

/** Vérifie qu'un pubkey LN a signé la revendication d'un operator_id.
 *
 *  @param nodePubkeyHex   pubkey compressée LN (66 hex chars, 0x02/0x03 prefix)
 *  @param operatorId      identifiant opaque de l'operator revendiqué
 *  @param signatureHex    signature ECDSA (DER ou compact r||s, 128-142 hex)
 *
 *  Le message signé est `buildLnChallenge(operatorId)`. secp256k1.verify
 *  hash le message par défaut (sha256) — on lui passe les octets UTF-8 bruts
 *  du challenge, identique au flow `lnd signmessage -k <msg>` côté client
 *  quand le client préfixe lui-même le challenge attendu. */
export function verifyLnPubkeyOwnership(
  nodePubkeyHex: string,
  operatorId: string,
  signatureHex: string,
): VerifyResult {
  if (!/^[0-9a-fA-F]{66}$/.test(nodePubkeyHex)) {
    return { valid: false, detail: 'pubkey_invalid_format' };
  }
  if (!operatorId || operatorId.length > 128) {
    return { valid: false, detail: 'operator_id_invalid' };
  }

  let pubkeyBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    pubkeyBytes = hexToBytes(nodePubkeyHex);
    sigBytes = hexToBytes(signatureHex);
  } catch {
    return { valid: false, detail: 'hex_decode_failed' };
  }

  const challenge = buildLnChallenge(operatorId);
  const msgBytes = new TextEncoder().encode(challenge);

  try {
    const ok = secp256k1.verify(sigBytes, msgBytes, pubkeyBytes);
    return ok ? { valid: true } : { valid: false, detail: 'bad_signature' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, detail: `verify_threw:${msg.slice(0, 40)}` };
  }
}

// ---------------------------------------------------------------------------
// 2. NIP-05 ownership — resolve name@domain → pubkey et match
// ---------------------------------------------------------------------------

/** Fetcher injectable pour faciliter les tests unitaires. */
export type NostrJsonFetcher = (url: string) => Promise<Record<string, unknown> | null>;

const FETCH_TIMEOUT_MS = 5000;

/** Fetch real-world avec timeout + SSRF + content-type minimal. */
const defaultNostrJsonFetcher: NostrJsonFetcher = async (url) => {
  const pinned = await resolveAndPin(url);
  if (pinned === null) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'error', // SSRF : pas de suivi de redirect
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!/json/i.test(ct)) return null;
    const body = (await res.json()) as unknown;
    if (body === null || typeof body !== 'object') return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** Vérifie qu'un identifiant NIP-05 (name@domain) pointe vers un pubkey Nostr
 *  attendu. Ne prouve pas en soi qu'un operator possède le domaine, mais
 *  l'opérateur doit aussi présenter un événement signé par ce pubkey (ou une
 *  seconde preuve DNS/LN) pour que le 2/3 se déclenche. */
export async function verifyNip05Ownership(
  nip05: string,
  expectedPubkeyHex: string,
  fetcher: NostrJsonFetcher = defaultNostrJsonFetcher,
): Promise<VerifyResult> {
  const match = nip05.match(/^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+)$/);
  if (!match) return { valid: false, detail: 'nip05_invalid_format' };
  const [, name, domain] = match;
  if (!/^[0-9a-fA-F]{64}$/.test(expectedPubkeyHex)) {
    return { valid: false, detail: 'pubkey_invalid_format' };
  }

  const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
  const body = await fetcher(url);
  if (body === null) return { valid: false, detail: 'fetch_failed' };

  const names = (body as { names?: unknown }).names;
  if (names === null || typeof names !== 'object') {
    return { valid: false, detail: 'names_missing' };
  }
  const nameKey = name.toLowerCase();
  const found = (names as Record<string, unknown>)[nameKey] ?? (names as Record<string, unknown>)[name];
  if (typeof found !== 'string') return { valid: false, detail: 'name_not_found' };
  if (found.toLowerCase() !== expectedPubkeyHex.toLowerCase()) {
    return { valid: false, detail: 'pubkey_mismatch' };
  }
  return { valid: true };
};

// ---------------------------------------------------------------------------
// 3. DNS TXT ownership — _satrank.<domain> TXT "satrank-operator=<id>"
// ---------------------------------------------------------------------------

/** Résolveur TXT injectable pour les tests. */
export type DnsTxtResolver = (hostname: string) => Promise<string[][]>;

const defaultDnsResolver: DnsTxtResolver = async (hostname) => {
  const { resolveTxt } = await import('node:dns/promises');
  try {
    return await resolveTxt(hostname);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug({ hostname, error: msg }, 'DNS TXT resolve failed');
    return [];
  }
};

/** Le préfixe publié doit correspondre exactement à l'operator_id revendiqué.
 *  Un opérateur peut publier plusieurs entrées (e.g. rotation d'identité) :
 *  on accepte la preuve si AU MOINS une entrée correspond. */
export async function verifyDnsOwnership(
  domain: string,
  operatorId: string,
  resolver: DnsTxtResolver = defaultDnsResolver,
): Promise<VerifyResult> {
  if (!/^[A-Za-z0-9.-]+$/.test(domain) || domain.length > 253) {
    return { valid: false, detail: 'domain_invalid' };
  }
  if (!operatorId || operatorId.length > 128) {
    return { valid: false, detail: 'operator_id_invalid' };
  }

  const hostname = `_satrank.${domain}`;
  const records = await resolver(hostname);
  if (records.length === 0) return { valid: false, detail: 'no_txt_record' };

  // Chaque record TXT est un tableau de chunks (RFC1035 : 255 octets max par
  // chunk). On les concatène avant le test d'égalité.
  const expected = `satrank-operator=${operatorId}`;
  for (const chunks of records) {
    const joined = chunks.join('');
    if (joined === expected) return { valid: true };
  }
  return { valid: false, detail: 'no_matching_record' };
}
