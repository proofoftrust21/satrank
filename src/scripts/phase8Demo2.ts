// Phase 8 — Checkpoint 2 end-to-end demo, re-runnable.
//
// Exécute in-process le scheduler multi-kind contre une DB in-memory + un
// stub publisher (pas de réseau). Vise à matérialiser les 3 scénarios de
// l'acceptance Checkpoint 2 :
//   A. Entité modifiée significativement → cron détecte → publie → cache
//      mis à jour.
//   B. Deuxième scan sans changement → no publish (shouldRepublish=false).
//   C. Flash 20900 déclenché sur transition verdict artificielle.
//
// Pour rejouer : `npx tsx src/scripts/phase8Demo2.ts`
// Ne nécessite ni NOSTR_PRIVATE_KEY, ni accès relais.
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import {
  EndpointStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import { NostrPublishedEventsRepository } from '../repositories/nostrPublishedEventsRepository';
import { NostrMultiKindScheduler } from '../nostr/nostrMultiKindScheduler';
import type { NostrMultiKindPublisher, PublishResult } from '../nostr/nostrMultiKindPublisher';
import type {
  EndpointEndorsementState,
  NodeEndorsementState,
  VerdictFlashState,
} from '../nostr/eventBuilders';

// Stub publisher : journal chaque appel, pas de réseau.
interface LoggedCall { tag: 'endorse' | 'flash'; kind: number; entityId: string; meta?: Record<string, unknown> }

class DemoPublisher {
  calls: LoggedCall[] = [];
  private nextId = 0;
  private id(): string { this.nextId++; return this.nextId.toString(16).padStart(64, '0'); }

  async publishEndpointEndorsement(state: EndpointEndorsementState, nowSec: number): Promise<PublishResult> {
    this.calls.push({ tag: 'endorse', kind: 30383, entityId: state.url_hash, meta: { verdict: state.verdict, p_success: state.p_success.toFixed(3) } });
    return { eventId: this.id(), kind: 30383, publishedAt: nowSec, acks: [{ relay: 'demo', result: 'success' }], anySuccess: true };
  }
  async publishNodeEndorsement(state: NodeEndorsementState, nowSec: number): Promise<PublishResult> {
    this.calls.push({ tag: 'endorse', kind: 30382, entityId: state.node_pubkey, meta: { verdict: state.verdict } });
    return { eventId: this.id(), kind: 30382, publishedAt: nowSec, acks: [{ relay: 'demo', result: 'success' }], anySuccess: true };
  }
  async publishVerdictFlash(state: VerdictFlashState, nowSec: number): Promise<PublishResult> {
    this.calls.push({ tag: 'flash', kind: 20900, entityId: state.entity_id, meta: { from: state.from_verdict ?? 'NONE', to: state.to_verdict } });
    return { eventId: this.id(), kind: 20900, publishedAt: nowSec, acks: [{ relay: 'demo', result: 'success' }], anySuccess: true };
  }
  async close(): Promise<void> {}
}

function title(s: string): void {
  process.stdout.write(`\n=== ${s} ===\n`);
}

async function main(): Promise<void> {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const endpointStreaming = new EndpointStreamingPosteriorRepository(db);
  const nodeStreaming = new NodeStreamingPosteriorRepository(db);
  const publishedEvents = new NostrPublishedEventsRepository(db);
  const publisher = new DemoPublisher();
  const scheduler = new NostrMultiKindScheduler(
    publisher as unknown as NostrMultiKindPublisher,
    endpointStreaming,
    nodeStreaming,
    publishedEvents,
    null,
    null,
    db,
  );

  const urlHash = 'a'.repeat(64);
  const nodePubkey = '02' + 'c'.repeat(64);
  let now = 1_700_000_000;

  title('Scenario A — entity modified → first publish');
  for (let i = 0; i < 40; i++) {
    endpointStreaming.ingest(urlHash, 'probe', { successDelta: 1, failureDelta: 0, nowSec: now });
    endpointStreaming.ingest(urlHash, 'report', { successDelta: 1, failureDelta: 0, nowSec: now });
  }
  for (let i = 0; i < 30; i++) {
    nodeStreaming.ingest(nodePubkey, 'probe', { successDelta: 1, failureDelta: 0, nowSec: now });
    nodeStreaming.ingest(nodePubkey, 'report', { successDelta: 1, failureDelta: 0, nowSec: now });
  }

  const resA = await scheduler.runScan(now);
  for (const r of resA.perType) {
    process.stdout.write(`${r.entityType}: scanned=${r.scanned} published=${r.published} firstPublish=${r.firstPublish} flashesPublished=${r.flashesPublished}\n`);
  }
  process.stdout.write(`publisher calls so far (${publisher.calls.length}):\n`);
  for (const c of publisher.calls) process.stdout.write(`  - ${c.tag} kind=${c.kind} entity=${c.entityId.slice(0, 12)}… ${JSON.stringify(c.meta)}\n`);

  const cached = publishedEvents.getLastPublished('endpoint', urlHash);
  process.stdout.write(`cache row endpoint: verdict=${cached?.verdict} p=${cached?.p_success?.toFixed(3)} n=${cached?.n_obs_effective?.toFixed(1)}\n`);

  title('Scenario B — second scan without changes → skip');
  publisher.calls.length = 0;
  now += 60; // 1 min plus tard
  const resB = await scheduler.runScan(now);
  for (const r of resB.perType) {
    process.stdout.write(`${r.entityType}: scanned=${r.scanned} published=${r.published} skippedNoChange=${r.skippedNoChange} skippedHashIdentical=${r.skippedHashIdentical}\n`);
  }
  process.stdout.write(`publisher calls this cycle: ${publisher.calls.length} (expected 0)\n`);

  title('Scenario C — inject failures to flip SAFE → RISKY → flash');
  publisher.calls.length = 0;
  now += 3600; // 1h plus tard
  for (let i = 0; i < 100; i++) {
    endpointStreaming.ingest(urlHash, 'probe', { successDelta: 0, failureDelta: 1, nowSec: now });
  }
  const resC = await scheduler.runScan(now);
  for (const r of resC.perType) {
    process.stdout.write(`${r.entityType}: published=${r.published} flashesPublished=${r.flashesPublished} flashErrors=${r.flashErrors}\n`);
  }
  for (const c of publisher.calls) process.stdout.write(`  - ${c.tag} kind=${c.kind} entity=${c.entityId.slice(0, 12)}… ${JSON.stringify(c.meta)}\n`);
  const cachedAfter = publishedEvents.getLastPublished('endpoint', urlHash);
  process.stdout.write(`cache row endpoint after flip: verdict=${cachedAfter?.verdict} p=${cachedAfter?.p_success?.toFixed(3)}\n`);

  title('Repository stats');
  const counts = publishedEvents.countByKind();
  const latest = publishedEvents.latestPublishedAtByType();
  process.stdout.write(`countByKind: ${JSON.stringify(counts)}\n`);
  process.stdout.write(`latestPublishedAtByType: ${JSON.stringify(latest)}\n`);

  db.close();
  process.stdout.write('\n=== Done ===\n');
}

main().catch((err) => {
  process.stderr.write(`demo failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
