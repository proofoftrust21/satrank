// Phase 8 — one-shot checkpoint demo, re-runnable.
//
// Commité volontairement pour pouvoir rejouer en cas de debug futur ou pour
// valider un nouveau relai : exécute `npx tsx src/scripts/phase8Demo.ts` et
// vérifie visuellement (event ID, acks, shouldRepublish decisions).
//
// 1. Signe un event kind 30383 avec une clé éphémère de test et le publie
//    sur 2 relais (damus + primal). Le resultat (event JSON complet + ids
//    + acks per relai) est loggé pour validation humaine.
// 2. Démonstration shouldRepublish sur 3 scenarios (significant / micro /
//    no-change).
//
// Ne nécessite aucune DB — juste un accès sortant aux relais.
// Node 18 n'expose pas crypto.getRandomValues global, et WebSocket global est
// arrivé en Node 22 — on polyfill les deux avant d'importer nostr-tools.
import { webcrypto } from 'node:crypto';
import WS from 'ws';
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as unknown as { crypto: typeof webcrypto }).crypto = webcrypto;
}
if (!(globalThis as { WebSocket?: unknown }).WebSocket) {
  (globalThis as unknown as { WebSocket: typeof WS }).WebSocket = WS;
}

import { buildEndpointEndorsement, type EndpointEndorsementState } from '../nostr/eventBuilders';
import { NostrMultiKindPublisher } from '../nostr/nostrMultiKindPublisher';
import { shouldRepublish, type EndorsementSnapshot } from '../nostr/shouldRepublish';

const TEST_RELAYS = ['wss://relay.damus.io', 'wss://relay.primal.net'];

async function main(): Promise<void> {
  // 1. Génère une secret key de test jetable — ne persiste pas, ne réutilise pas.
  // Node 18 n'expose pas crypto.getRandomValues global → on passe par crypto.randomBytes
  // plutôt que nostr-tools' generateSecretKey().
  const { randomBytes } = await import('node:crypto');
  const sk = randomBytes(32);
  const skHex = sk.toString('hex');

  process.stdout.write('\n=== 1. Example kind 30383 event (endpoint endorsement) ===\n');

  const endpointState: EndpointEndorsementState = {
    url_hash: 'a2c5d680750f333f535286a5527a18b4ea0dcb2195e7e5fd710b1407270a4308',
    url: 'https://satrank.dev/api/decide',
    verdict: 'INSUFFICIENT',
    p_success: 0.5,
    ci95_low: 0.061,
    ci95_high: 0.939,
    n_obs: 0,
    advisory_level: 'yellow',
    risk_score: 0.15,
    source: 'probe',
    time_constant_days: 7,
    last_update: Math.floor(Date.now() / 1000),
    price_sats: 21,
    median_latency_ms: null,
    category: 'bitcoin',
    service_name: 'SatRank Decide',
    operator_id: 'fce15c4cf8db86db85778ea4ba9a382075d36d8c19c7ad2c6ffe8f624a5f42cb',
  };

  const template = buildEndpointEndorsement(endpointState, Math.floor(Date.now() / 1000));
  process.stdout.write(`Template:\n${JSON.stringify(template, null, 2)}\n`);

  const publisher = new NostrMultiKindPublisher({
    privateKeyHex: skHex,
    relays: TEST_RELAYS,
    publishTimeoutMs: 3_000,
    connectTimeoutMs: 5_000,
  });
  const result = await publisher.publishEndpointEndorsement(endpointState, Math.floor(Date.now() / 1000));
  process.stdout.write(`\nPublish result:\n${JSON.stringify(result, null, 2)}\n`);
  await publisher.close();

  // 2. Demo shouldRepublish sur 3 scenarios
  process.stdout.write('\n=== 2. shouldRepublish demo ===\n');

  const previous: EndorsementSnapshot = {
    verdict: 'SAFE',
    advisory_level: 'green',
    p_success: 0.80,
    n_obs_effective: 100,
  };

  const scenarios: { name: string; current: EndorsementSnapshot }[] = [
    {
      name: 'Scenario A — significant shift (p_success -0.10, verdict SAFE→RISKY)',
      current: { verdict: 'RISKY', advisory_level: 'orange', p_success: 0.70, n_obs_effective: 105 },
    },
    {
      name: 'Scenario B — micro-variation (p_success +0.02, same verdict/advisory)',
      current: { verdict: 'SAFE', advisory_level: 'green', p_success: 0.82, n_obs_effective: 105 },
    },
    {
      name: 'Scenario C — no change at all',
      current: { ...previous },
    },
  ];

  for (const { name, current } of scenarios) {
    const decision = shouldRepublish(previous, current);
    process.stdout.write(`\n${name}\n`);
    process.stdout.write(`Decision: ${JSON.stringify(decision, null, 2)}\n`);
  }

  process.stdout.write('\n=== Done ===\n');
}

main().catch((err) => {
  process.stderr.write(`demo failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
