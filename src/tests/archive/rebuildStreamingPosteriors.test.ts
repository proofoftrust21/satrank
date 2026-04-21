// @ts-nocheck — archived 2026-04-22 in Phase 12C (SQLite-era better-sqlite3 API, not ported to pg). See docs/phase-12c/TS-ERRORS-AUDIT.md.
// Phase 3 C11 — rebuildStreamingPosteriors script.
//
// Tests :
//   - rebuild depuis zéro → streaming + buckets cohérents
//   - --truncate réinitialise avant rebuild (state déterministe)
//   - ordre chronologique → décroissance conforme au live
//   - intent skippé complètement
//   - --dry-run n'écrit rien mais rapporte les compteurs corrects
//   - --from-ts filtre
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { AgentRepository } from '../repositories/agentRepository';
import {
  EndpointStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import {
  EndpointDailyBucketsRepository,
} from '../repositories/dailyBucketsRepository';
import { runRebuild } from '../scripts/rebuildStreamingPosteriors';
import type { Agent } from '../types';
let testDb: TestDb;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

function makeAgent(hash: string): Agent {
  return {
    public_key_hash: hash,
    public_key: null,
    alias: `a-${hash.slice(0, 6)}`,
    first_seen: NOW - 90 * DAY,
    last_seen: NOW - DAY,
    source: 'lightning_graph',
    total_transactions: 0,
    total_attestations_received: 0,
    avg_score: 0,
    capacity_sats: null,
    positive_ratings: 0,
    negative_ratings: 0,
    lnplus_rank: 0,
    hubness_rank: 0,
    betweenness_rank: 0,
    hopness_rank: 0,
    unique_peers: null,
    last_queried_at: null,
    query_count: 0,
  };
}

function insertTx(
  db: Pool,
  opts: {
    tx_id: string;
    target_hash: string;
    ts: number;
    source: 'probe' | 'report' | 'paid' | 'intent' | null;
    status?: 'verified' | 'failed';
  },
) {
  db.prepare(`
    INSERT INTO transactions (
      tx_id, sender_hash, receiver_hash, amount_bucket, timestamp,
      payment_hash, preimage, status, protocol,
      endpoint_hash, operator_id, source, window_bucket
    ) VALUES (?, ?, ?, 'micro', ?, ?, NULL, ?, 'bolt11', ?, ?, ?, ?)
  `).run(
    opts.tx_id,
    opts.target_hash,
    opts.target_hash,
    opts.ts,
    `${opts.tx_id}:ph`,
    opts.status ?? 'verified',
    opts.target_hash,
    opts.target_hash,
    opts.source,
    new Date(opts.ts * 1000).toISOString().slice(0, 10),
  );
}

// TODO Phase 12B: describe uses helpers with SQLite .prepare/.run/.get/.all — port fixtures to pg before unskipping.
describe.skip('rebuildStreamingPosteriors', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    agentRepo = new AgentRepository(db);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('rebuild populates streaming_posteriors + daily_buckets from transactions', async () => {
    const target = 'aa'.repeat(32);
    await agentRepo.insert(makeAgent(target));

    for (let i = 0; i < 10; i++) {
      insertTx(db, {
        tx_id: `probe-${i}`,
        target_hash: target,
        ts: NOW - i * DAY,
        source: 'probe',
      });
    }

    const result = runRebuild({ db });
    expect(result.scanned).toBe(10);
    expect(result.ingested).toBe(10);
    expect(result.perSource.probe).toBe(10);
    expect(result.errors).toBe(0);

    const streaming = new EndpointStreamingPosteriorRepository(db);
    const decayed = await streaming.readDecayed(target, 'probe', NOW);
    expect(decayed.totalIngestions).toBe(10);
    expect(decayed.nObsEffective).toBeGreaterThan(0);

    const buckets = new EndpointDailyBucketsRepository(db);
    const activity = await buckets.recentActivity(target, NOW);
    expect(activity.last_30d).toBe(10);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('--truncate réinitialise les tables streaming/buckets avant rebuild', async () => {
    const target = 'bb'.repeat(32);
    await agentRepo.insert(makeAgent(target));

    // Pré-seed : state existant incohérent
    db.prepare(`
      INSERT INTO endpoint_streaming_posteriors
        (url_hash, source, posterior_alpha, posterior_beta, last_update_ts, total_ingestions)
      VALUES (?, 'probe', 99.0, 99.0, ?, 999)
    `).run(target, NOW - 1000);

    // Ajoute 3 vraies rows de prod
    for (let i = 0; i < 3; i++) {
      insertTx(db, {
        tx_id: `probe-${i}`,
        target_hash: target,
        ts: NOW - i * 60,
        source: 'probe',
      });
    }

    runRebuild({ db, truncate: true });

    const streaming = new EndpointStreamingPosteriorRepository(db);
    const stored = await streaming.findStored(target, 'probe');
    expect(stored?.totalIngestions).toBe(3); // pas 999 + 3
  });

  it('intent rows sont skippées complètement (contrat Phase 3)', async () => {
    const target = 'dd'.repeat(32);
    await agentRepo.insert(makeAgent(target));

    for (let i = 0; i < 4; i++) {
      insertTx(db, {
        tx_id: `int-${i}`,
        target_hash: target,
        ts: NOW - i * 60,
        source: 'intent',
      });
    }

    const result = runRebuild({ db, truncate: true });
    expect(result.scanned).toBe(4);
    expect(result.skippedIntent).toBe(4);
    expect(result.ingested).toBe(0);

    const streaming = new EndpointStreamingPosteriorRepository(db);
    expect(await streaming.findStored(target, 'probe')).toBeUndefined();
    const buckets = new EndpointDailyBucketsRepository(db);
    expect(await buckets.recentActivity(target, NOW).last_30d).toBe(0);
  });

  it('--dry-run counts without writing', async () => {
    const target = 'ee'.repeat(32);
    await agentRepo.insert(makeAgent(target));

    for (let i = 0; i < 7; i++) {
      insertTx(db, {
        tx_id: `probe-${i}`,
        target_hash: target,
        ts: NOW - i * 60,
        source: 'probe',
      });
    }

    const result = runRebuild({ db, dryRun: true });
    expect(result.scanned).toBe(7);
    expect(result.ingested).toBe(7);

    const streaming = new EndpointStreamingPosteriorRepository(db);
    expect(await streaming.findStored(target, 'probe')).toBeUndefined();
  });

  it('--from-ts filters older rows', async () => {
    const target = 'ff'.repeat(32);
    await agentRepo.insert(makeAgent(target));

    insertTx(db, { tx_id: 'old', target_hash: target, ts: NOW - 30 * DAY, source: 'probe' });
    insertTx(db, { tx_id: 'recent', target_hash: target, ts: NOW - DAY, source: 'probe' });

    const result = runRebuild({ db, truncate: true, fromTs: NOW - 7 * DAY });
    expect(result.scanned).toBe(1);
    expect(result.ingested).toBe(1);
  });

  it('rows avec source=NULL sont skippées (pre-v31 legacy)', async () => {
    const target = '11'.repeat(32);
    await agentRepo.insert(makeAgent(target));
    insertTx(db, { tx_id: 'legacy', target_hash: target, ts: NOW - 60, source: null });

    const result = runRebuild({ db });
    // Le query SQL filtre déjà source IS NOT NULL — scanned reflète ce filtre
    expect(result.scanned).toBe(0);
  });
});