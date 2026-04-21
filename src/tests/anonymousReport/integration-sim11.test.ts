// Intégration end-to-end sim #11 replay :
//   1. Crawler voit un endpoint L402 → extrait BOLT11 → peuple preimage_pool
//      (voie 1, tier='medium', source='crawler').
//   2. Un agent paie l'endpoint L402 off-scope (simulé).
//   3. Il POST /api/report avec X-L402-Preimage + outcome, sans API-key.
//   4. Vérification : 200, reporter_identity=preimage_pool:<hash>,
//      confidence_tier=medium, reporter_weight_applied=0.5, verdict mis à jour.
// Plus un test concurrence : deux requêtes simultanées sur la même preimage →
// exactement 1 gagnant (200) et 1 perdant (409 DUPLICATE_REPORT).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from '../helpers/testDatabase';
import { createHash } from 'node:crypto';
import request from 'supertest';
import express from 'express';
import { PreimagePoolRepository } from '../../repositories/preimagePoolRepository';
import { ServiceEndpointRepository } from '../../repositories/serviceEndpointRepository';
import { RegistryCrawler } from '../../crawler/registryCrawler';
import { V2Controller } from '../../controllers/v2Controller';
import { AgentRepository } from '../../repositories/agentRepository';
import { TransactionRepository } from '../../repositories/transactionRepository';
import { AttestationRepository } from '../../repositories/attestationRepository';
import { SnapshotRepository } from '../../repositories/snapshotRepository';
import { ProbeRepository } from '../../repositories/probeRepository';
import { ScoringService } from '../../services/scoringService';
import { TrendService } from '../../services/trendService';
import { RiskService } from '../../services/riskService';
import { ReportService } from '../../services/reportService';
import { AgentService } from '../../services/agentService';
import { createReportDispatchAuth } from '../../middleware/auth';
import { sha256 } from '../../utils/crypto';
import { errorHandler } from '../../middleware/errorHandler';
import { createBayesianVerdictService } from '../helpers/bayesianTestFactory';
import type { Agent } from '../../types';
import type { RequestHandler } from 'express';
let testDb: TestDb;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

// Fixture BOLT11 mainnet (BOLT11 spec) dont payment_hash est connu.
const MAINNET_INVOICE = 'lnbc20u1pvjluezhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqfppqw508d6qejxtdg4y5r3zarvary0c5xw7kxqrrsssp5m6kmam774klwlh4dhmhaatd7al02m0h0m6kmam774klwlh4dhmhs9qypqqqcqpf3cwux5979a8j28d4ydwahx00saa68wq3az7v9jdgzkghtxnkf3z5t7q5suyq2dl9tqwsap8j0wptc82cpyvey9gf6zyylzrm60qtcqsq7egtsq';
const MAINNET_PAYMENT_HASH = '0001020304050607080900010203040506070809000102030405060708090102';

function makeAgent(alias: string, overrides: Partial<Agent> = {}): Agent {
  return {
    public_key_hash: sha256(alias),
    public_key: '02' + sha256(alias),
    alias,
    first_seen: NOW - 365 * DAY,
    last_seen: NOW - 3600,
    source: 'lightning_graph',
    total_transactions: 10,
    total_attestations_received: 2,
    avg_score: 70,
    capacity_sats: 100_000_000,
    positive_ratings: 1,
    negative_ratings: 0,
    lnplus_rank: 0,
    hubness_rank: 0,
    betweenness_rank: 0,
    hopness_rank: 0,
    unique_peers: null,
    last_queried_at: null,
    query_count: 1,
    ...overrides,
  };
}

function mockFetchFactory(invoiceToReturn: string): typeof fetch {
  const fakeFetch: typeof fetch = async (input: string | URL | Request) => {
    const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
    if (urlStr.includes('402index.io/api/v1/services')) {
      const body = JSON.stringify({
        services: [{ url: 'https://api.example.com/svc', protocol: 'L402', name: 'example', description: null, category: null, provider: null }],
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (urlStr.includes('api.example.com/svc')) {
      const headers = new Headers();
      headers.set('www-authenticate', `L402 macaroon="fakemacaroon", invoice="${invoiceToReturn}"`);
      return new Response('', { status: 402, headers });
    }
    return new Response('not found', { status: 404 });
  };
  return fakeFetch;
}

function buildContext(db: Pool) {
  const agentRepo = new AgentRepository(db);
  const txRepo = new TransactionRepository(db);
  const attestationRepo = new AttestationRepository(db);
  const snapshotRepo = new SnapshotRepository(db);
  const probeRepo = new ProbeRepository(db);
  const preimagePoolRepo = new PreimagePoolRepository(db);
  const serviceEndpointRepo = new ServiceEndpointRepository(db);
  const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
  const trendService = new TrendService(agentRepo, snapshotRepo);
  const riskService = new RiskService();
  const bayesianVerdictService = createBayesianVerdictService(db);
  const reportService = new ReportService(attestationRepo, agentRepo, txRepo, scoringService, db, 'off');
  const agentService = new AgentService(agentRepo, txRepo, attestationRepo, bayesianVerdictService, probeRepo);

  const v2 = new V2Controller(
    reportService, agentService, agentRepo, attestationRepo, scoringService,
    trendService, riskService, probeRepo, undefined, undefined, undefined,
    db, undefined, preimagePoolRepo,
  );

  const legacyAuth: RequestHandler = (_req, _res, next) => {
    next(new Error('legacy auth invoked — anonymous path should bypass this'));
  };

  const app = express();
  app.use(express.json());
  app.post('/api/report', createReportDispatchAuth(legacyAuth), v2.report);
  app.use(errorHandler);

  return { app, preimagePoolRepo, serviceEndpointRepo, agentRepo, attestationRepo };
}

// TODO Phase 12B: describe uses helpers with SQLite .prepare/.run/.get/.all — port fixtures to pg before unskipping.
describe.skip('Intégration Phase 2 — sim #11 replay end-to-end', async () => {
  let db: Pool;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    originalFetch = global.fetch;
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    await teardownTestPool(testDb);
  });

  it('sim #11 : crawl → pool feed → pay off-scope → POST /api/report anonyme → attestation créée', async () => {
    // Fixture cryptographique : preimage obtenue en payant l'invoice mainnet.
    // En vrai, l'agent reçoit la preimage de son wallet après règlement ;
    // ici on utilise une preimage arbitraire dont sha256 = MAINNET_PAYMENT_HASH.
    // Comme on ne peut pas inverser sha256, on contourne en injectant un
    // payment_hash dérivé d'une preimage générée ET en forçant l'invoice
    // crawlé à correspondre. Mais ça nécessite de signer un BOLT11 — trop lourd.
    //
    // Alternative : étape 1 utilise MAINNET fixture (payment_hash connu) ;
    // étape 2-3 utilise ce même payment_hash + une preimage "feinte" mais
    // le contrôleur dérive payment_hash = sha256(preimage) et ne matchera pas.
    //
    // Solution propre pour intégration : dérive le couple (preimage,
    // payment_hash) et insère manuellement l'entrée de pool au tier='medium'
    // source='crawler' pour simuler la sortie du crawler. L'étape 1 est
    // couverte à part dans voies12-pool-feed.test.ts — ici on teste le replay
    // end-to-end à partir d'une pool déjà peuplée, ce qui est l'état prod
    // stable attendu.
    const preimage = createHash('sha256').update('integration-preimage-seed').digest('hex');
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');

    const { app, preimagePoolRepo, agentRepo, attestationRepo } = buildContext(db);

    // Étape 1 : simule la sortie du crawler voie 1 (équivalent d'un run avec
    // MAINNET_INVOICE, couvert en détail dans voies12-pool-feed.test.ts).
    await preimagePoolRepo.insertIfAbsent({
      paymentHash,
      bolt11Raw: MAINNET_INVOICE,
      firstSeen: NOW,
      confidenceTier: 'medium',
      source: 'crawler',
    });

    // Target de l'oracle (le service L402 crawlé)
    const target = makeAgent('target-sim11');
    await agentRepo.insert(target);

    // Étape 2-3 : agent paie off-scope (preimage reçue), POST /api/report
    const res = await request(app)
      .post('/api/report')
      .set('X-L402-Preimage', preimage)
      .send({ target: target.public_key_hash, outcome: 'success' });

    expect(res.status).toBe(200);
    expect(res.body.data.reporter_identity).toBe(`preimage_pool:${paymentHash}`);
    expect(res.body.data.confidence_tier).toBe('medium');
    expect(res.body.data.reporter_weight_applied).toBe(0.5);
    expect(res.body.data.verified).toBe(true);

    // Vérification : attestation inscrite avec category=successful_transaction
    const attestations = await attestationRepo.countBySubject(target.public_key_hash);
    expect(attestations).toBe(1);

    // Vérification : pool entry consommée, pointée vers le reportId
    const entry = await preimagePoolRepo.findByPaymentHash(paymentHash);
    expect(entry?.consumed_at).not.toBeNull();
    expect(entry?.consumer_report_id).toBe(res.body.data.reportId);
  });

  // TODO Phase 12B: port SQLite fixtures (db.prepare/run/get/all) to pg before unskipping.
  it.skip('concurrence : 2 requêtes simultanées sur la même preimage → 1 winner 200 + 1 loser 409', async () => {
    const preimage = createHash('sha256').update('concurrent-preimage').digest('hex');
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');

    const { app, preimagePoolRepo, agentRepo } = buildContext(db);

    await preimagePoolRepo.insertIfAbsent({
      paymentHash,
      bolt11Raw: null,
      firstSeen: NOW,
      confidenceTier: 'medium',
      source: 'crawler',
    });

    const target = makeAgent('target-concurrent');
    await agentRepo.insert(target);

    // Promise.all sur 2 POST /api/report avec la même preimage. consumeAtomic
    // (UPDATE ... WHERE consumed_at IS NULL) est atomique SQLite : une seule
    // update peut toucher la ligne, l'autre voit changes=0 → 409.
    const [res1, res2] = await Promise.all([
      request(app)
        .post('/api/report')
        .set('X-L402-Preimage', preimage)
        .send({ target: target.public_key_hash, outcome: 'success' }),
      request(app)
        .post('/api/report')
        .set('X-L402-Preimage', preimage)
        .send({ target: target.public_key_hash, outcome: 'failure' }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const loser = res1.status === 409 ? res1 : res2;
    expect(loser.body.error.code).toBe('DUPLICATE_REPORT');

    // Exactement 1 attestation — l'autre request a été rejetée avant insertion
    const { attestationRepo } = buildContext(db);
    const attestations = await attestationRepo.countBySubject(target.public_key_hash);
    expect(attestations).toBe(1);
  });
});
