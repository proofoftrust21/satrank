// Nostr publisher tests — verify event format, Bayesian tag shape, and signing (C10).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ProbeRepository } from '../repositories/probeRepository';
import { ScoringService } from '../services/scoringService';
import { SurvivalService } from '../services/survivalService';
import { BayesianVerdictService } from '../services/bayesianVerdictService';
import { createBayesianVerdictService, ingestBayesianObservation } from './helpers/bayesianTestFactory';
import type { BayesianSource } from '../config/bayesianConfig';
import { NostrPublisher } from '../nostr/publisher';
import { sha256 } from '../utils/crypto';
import type { Agent } from '../types';
let testDb: TestDb;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

// Test keypair (not a real secret — generated for tests)
const TEST_SK = 'a'.repeat(64);

function makeAgent(alias: string, overrides: Partial<Agent> = {}): Agent {
  return {
    public_key_hash: sha256(alias),
    public_key: '02' + sha256(alias),
    alias,
    first_seen: NOW - 365 * DAY,
    last_seen: NOW - 3600,
    source: 'lightning_graph',
    total_transactions: 100,
    total_attestations_received: 10,
    avg_score: 65,
    capacity_sats: 500000000,
    positive_ratings: 5,
    negative_ratings: 0,
    lnplus_rank: 3,
    hubness_rank: 10,
    betweenness_rank: 20,
    hopness_rank: 0,
    query_count: 10,
    unique_peers: null,
    last_queried_at: null,
    ...overrides,
  };
}

/** Insère une transaction vérifiée dans la table — on bypass la FK agents pour
 *  pouvoir tester le moteur bayésien sans maquetter tout l'objet Agent. */
async function insertTx(
  db: Pool,
  opts: { endpoint_hash: string; status?: string; source?: string; ts?: number },
): Promise<void> {
  const id = 'tx-' + Math.random().toString(36).slice(2, 12);
  const status = opts.status ?? 'verified';
  const source = opts.source ?? 'probe';
  const ts = opts.ts ?? NOW;
  // Seed placeholder sender/receiver agents to satisfy FK (idempotent).
  await db.query(
    `INSERT INTO agents (public_key_hash, first_seen, last_seen, source)
     VALUES ($1, $3, $3, 'manual'), ($2, $3, $3, 'manual')
     ON CONFLICT (public_key_hash) DO NOTHING`,
    ['a'.repeat(64), 'b'.repeat(64), ts],
  );
  await db.query(
    `INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp,
                              payment_hash, preimage, status, protocol,
                              endpoint_hash, operator_id, source, window_bucket)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      'a'.repeat(64),
      'b'.repeat(64),
      'medium',
      ts,
      'p'.repeat(64),
      null,
      status,
      'l402',
      opts.endpoint_hash,
      null,
      source,
      '2026-04-18',
    ],
  );
  // Le verdict Phase 3 lit directement dans streaming_posteriors ; on bump
  // aussi le streaming pour que ces tests restent cohérents avec la nouvelle
  // source de vérité (observer reste bucket-only, cf. CHECK constraint SQL).
  if (source !== 'intent') {
    await ingestBayesianObservation(db, {
      success: status === 'verified',
      timestamp: ts,
      source: source as BayesianSource | 'observer',
      endpointHash: opts.endpoint_hash,
    });
  }
}

describe('NostrPublisher', async () => {
  let db: Pool;
  let agentRepo: AgentRepository;
  let snapshotRepo: SnapshotRepository;
  let probeRepo: ProbeRepository;
  let scoringService: ScoringService;
  let survivalService: SurvivalService;
  let bayesianVerdictService: BayesianVerdictService;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    // FK OFF : les tests insèrent des transactions directement sans créer
    // les agents correspondants en base (on teste uniquement le shape du publisher).
agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    snapshotRepo = new SnapshotRepository(db);
    probeRepo = new ProbeRepository(db);
    scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
    survivalService = new SurvivalService(agentRepo, probeRepo, snapshotRepo);

    bayesianVerdictService = createBayesianVerdictService(db);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  function makePublisher(minScore = 30): NostrPublisher {
    return new NostrPublisher(
      agentRepo,
      probeRepo,
      snapshotRepo,
      scoringService,
      survivalService,
      bayesianVerdictService,
      { privateKeyHex: TEST_SK, relays: [], minScore },
    );
  }

  it('creates a publisher without errors', async () => {
    expect(makePublisher()).toBeDefined();
  });

  it('findScoredAbove returns agents above threshold', async () => {
    await agentRepo.insert(makeAgent('high', { avg_score: 80 }));
    await agentRepo.insert(makeAgent('mid', { avg_score: 40 }));
    await agentRepo.insert(makeAgent('low', { avg_score: 10 }));

    const above30 = await agentRepo.findScoredAbove(30);
    expect(above30.length).toBe(2);
    expect(above30[0].avg_score).toBeGreaterThanOrEqual(30);
  });

  it('publishScores returns 0 published when no relays configured', async () => {
    await agentRepo.insert(makeAgent('test-node', { avg_score: 50 }));
    await scoringService.computeScore(sha256('test-node'));

    const publisher = makePublisher();
    const result = await publisher.publishScores();
    expect(result.published).toBe(0);
    expect(result.errors).toBeGreaterThanOrEqual(0);
  });

  it('filters agents below minScore', async () => {
    await agentRepo.insert(makeAgent('above', { avg_score: 50 }));
    await agentRepo.insert(makeAgent('below', { avg_score: 20 }));

    const above = await agentRepo.findScoredAbove(30);
    expect(above.length).toBe(1);
    expect(above[0].alias).toBe('above');
  });

  // --- C10 : shape bayésien des events publiés ---

  it('buildScoreEvent retourne null quand aucune observation bayésienne (INSUFFICIENT)', async () => {
    const agent = makeAgent('no-data', { avg_score: 80 });
    await agentRepo.insert(agent);
    const publisher = makePublisher();
    const ev = await publisher.buildScoreEvent(agent);
    // Pas de transactions pour cet agent → verdict INSUFFICIENT → pas d'event publié.
    expect(ev).toBeNull();
  });

  it('buildScoreEvent expose le shape canonique Phase 3 avec données suffisantes', async () => {
    const agent = makeAgent('good-node', { avg_score: 80 });
    await agentRepo.insert(agent);
    // 25 probes verified sur l'endpoint de cet agent (public_key_hash)
    for (let i = 0; i < 25; i++) {
      await insertTx(db, { endpoint_hash: agent.public_key_hash, status: 'verified', source: 'probe' });
    }
    const publisher = makePublisher();
    const ev = await publisher.buildScoreEvent(agent);

    expect(ev).not.toBeNull();
    expect(ev!.lnPubkey).toBe(agent.public_key);
    expect(ev!.verdict).toBeDefined();
    expect(['SAFE', 'RISKY', 'UNKNOWN']).toContain(ev!.verdict);
    expect(typeof ev!.pSuccess).toBe('number');
    expect(ev!.pSuccess).toBeGreaterThanOrEqual(0);
    expect(ev!.pSuccess).toBeLessThanOrEqual(1);
    expect(ev!.ci95Low).toBeLessThanOrEqual(ev!.pSuccess);
    expect(ev!.ci95High).toBeGreaterThanOrEqual(ev!.pSuccess);
    expect(ev!.nObs).toBeGreaterThan(0);
    expect(typeof ev!.converged).toBe('boolean');
    expect(['operator', 'service', 'flat']).toContain(ev!.priorSource);
    expect(ev!.tauDays).toBe(7);
  });

  it('buildTags émet exactement les 13 tags bayésiens et AUCUN tag legacy', async () => {
    const agent = makeAgent('tag-test', { avg_score: 75 });
    await agentRepo.insert(agent);
    for (let i = 0; i < 25; i++) {
      await insertTx(db, { endpoint_hash: agent.public_key_hash, status: 'verified', source: 'probe' });
    }
    const publisher = makePublisher();
    const ev = await publisher.buildScoreEvent(agent);
    expect(ev).not.toBeNull();

    const tags = publisher.buildTags(ev!);
    const keys = tags.map(t => t[0]);

    // Shape Phase 3 — ordre arbitraire mais ensemble strict
    expect(keys.sort()).toEqual([
      'alias', 'ci95_high', 'ci95_low', 'converged', 'd', 'n',
      'n_obs', 'p_success', 'prior_source', 'reachable', 'survival',
      'tau_days', 'verdict',
    ]);

    // Anti-régression : aucun tag du composite legacy ne doit survivre.
    expect(keys).not.toContain('score');
    expect(keys).not.toContain('rank');
    expect(keys).not.toContain('volume');
    expect(keys).not.toContain('reputation');
    expect(keys).not.toContain('seniority');
    expect(keys).not.toContain('regularity');
    expect(keys).not.toContain('diversity');
  });

  it('buildTags sérialise p_success / ci95_* en fixed(4) et n_obs en entier', async () => {
    const agent = makeAgent('precision-test', { avg_score: 75 });
    await agentRepo.insert(agent);
    for (let i = 0; i < 25; i++) {
      await insertTx(db, { endpoint_hash: agent.public_key_hash, status: 'verified', source: 'probe' });
    }
    const publisher = makePublisher();
    const ev = await publisher.buildScoreEvent(agent);
    const tagMap = Object.fromEntries(publisher.buildTags(ev!));

    // p_success / ci95_* doivent avoir exactement 4 décimales (stabilité du fingerprint).
    expect(tagMap.p_success).toMatch(/^\d\.\d{4}$/);
    expect(tagMap.ci95_low).toMatch(/^\d\.\d{4}$/);
    expect(tagMap.ci95_high).toMatch(/^\d\.\d{4}$/);
    // n_obs est un compteur → entier sans décimales
    expect(tagMap.n_obs).toMatch(/^\d+$/);
    // converged et reachable sont des booleans string
    expect(['true', 'false']).toContain(tagMap.converged);
    expect(['true', 'false']).toContain(tagMap.reachable);
  });

  it('publishScores skip les agents INSUFFICIENT et ne construit pas d\'event pour eux', async () => {
    // 1 agent avec observations suffisantes, 1 agent sans données
    const good = makeAgent('good', { avg_score: 80 });
    const empty = makeAgent('empty', { avg_score: 80 });
    await agentRepo.insert(good);
    await agentRepo.insert(empty);
    for (let i = 0; i < 25; i++) {
      await insertTx(db, { endpoint_hash: good.public_key_hash, status: 'verified', source: 'probe' });
    }

    const publisher = makePublisher();
    // Pas de relais → on vérifie via le compte total (`total`) le nombre d'events candidats.
    const result = await publisher.publishScores();
    // good = 1 event construit (publiable), empty = 0 (INSUFFICIENT filtered out)
    expect(result.total).toBe(1);
  });
});
