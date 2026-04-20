// Phase 8 — dry-run signature réelle : produit un event 30383 + un flash 20900
// signés avec nostr-tools (Schnorr BIP-340) à partir d'une clé de test locale.
//
// Ne publie PAS — juste affiche le JSON signé, prouvant que le template
// builder + le signing path sont équivalents à ce qui sortira en prod.
// Clé privée purement locale (non-réutilisée ailleurs) générée par openssl.
// nostr-tools est ESM-only : import dynamique (même pattern que publisher.ts)
// pour contourner moduleResolution "node" qui ne résout pas les subpaths ESM.
import { hexToBytes } from '@noble/hashes/utils';
import {
  buildEndpointEndorsement,
  buildVerdictFlash,
  payloadHash,
  type EndpointEndorsementState,
  type VerdictFlashState,
} from '../nostr/eventBuilders';

// Polyfill crypto.getRandomValues pour Node — @noble/hashes le demande
// pour Schnorr (randomized aux). Node 16+ l'a via webcrypto, on l'expose
// au global.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { webcrypto } = require('node:crypto') as typeof import('node:crypto');
if (!(globalThis as { crypto?: Crypto }).crypto) {
  (globalThis as unknown as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}

// Clé dev jetable — NE SERA JAMAIS utilisée en prod.
const DEV_SK_HEX = '0000000000000000000000000000000000000000000000000000000000000001';

function write(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function title(s: string): void {
  process.stdout.write(`\n=== ${s} ===\n`);
}

async function main(): Promise<void> {
  // @ts-expect-error — moduleResolution "node" can't resolve ESM subpath
  const pure = await import('nostr-tools/pure');
  const finalizeEvent = pure.finalizeEvent as (tpl: unknown, sk: Uint8Array) => { id: string; sig: string };
  const sk = hexToBytes(DEV_SK_HEX);
  const createdAt = 1704067200;

  title('Kind 30383 — endpoint endorsement');
  const endpointState: EndpointEndorsementState = {
    url_hash: 'f3a2b1c87e4d' + '0'.repeat(52),
    url: 'https://api.example.l402/paid',
    verdict: 'SAFE',
    p_success: 0.9421,
    ci95_low: 0.8812,
    ci95_high: 0.9731,
    n_obs: 187,
    advisory_level: 'green',
    risk_score: 0.058,
    source: 'probe',
    time_constant_days: 7,
    last_update: 1704063600,
    operator_id: 'op_acme_labs',
    price_sats: 100,
    median_latency_ms: 284,
    category: 'weather',
    service_name: 'Weather Oracle',
  };
  const template30383 = buildEndpointEndorsement(endpointState, createdAt);
  const signed30383 = finalizeEvent(template30383, sk);
  write(signed30383);
  process.stdout.write(`payload_hash: ${payloadHash(template30383)}\n`);

  title('Kind 20900 — verdict flash SAFE → RISKY');
  const flashState: VerdictFlashState = {
    entity_type: 'endpoint',
    entity_id: endpointState.url_hash,
    from_verdict: 'SAFE',
    to_verdict: 'RISKY',
    p_success: 0.4441,
    ci95_low: 0.3890,
    ci95_high: 0.4993,
    n_obs: 287,
    advisory_level: 'orange',
    risk_score: 0.556,
    source: 'probe',
    time_constant_days: 7,
    last_update: 1704067240,
    operator_id: 'op_acme_labs',
  };
  const template20900 = buildVerdictFlash(flashState, createdAt + 60);
  const signed20900 = finalizeEvent(template20900, sk);
  write(signed20900);

  title('Verification summary');
  process.stdout.write(`30383 sig length: ${(signed30383 as { sig: string }).sig.length} (expect 128)\n`);
  process.stdout.write(`20900 sig length: ${(signed20900 as { sig: string }).sig.length} (expect 128)\n`);
  process.stdout.write(`30383 event_id: ${(signed30383 as { id: string }).id}\n`);
  process.stdout.write(`20900 event_id: ${(signed20900 as { id: string }).id}\n`);
  process.stdout.write('\n=== Done (dry-run — no broadcast) ===\n');
}

main().catch((err) => {
  process.stderr.write(`dry-run failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
