// Voies 1 & 2 — alimentation de preimage_pool via crawler (402index) et
// /api/decide (bolt11Raw). L'idempotence repose sur INSERT OR IGNORE au
// niveau DB ; on vérifie ici qu'on n'over-écrit pas un tier supérieur.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import express from 'express';
import { runMigrations } from '../../database/migrations';
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
import { VerdictService } from '../../services/verdictService';
import { DecideService } from '../../services/decideService';
import { ReportService } from '../../services/reportService';
import { AgentService } from '../../services/agentService';
import { sha256 } from '../../utils/crypto';
import { errorHandler } from '../../middleware/errorHandler';
import type { Agent } from '../../types';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

// BOLT11 mainnet from BOLT11 spec (payment_hash connu, utilisé aussi dans bolt11Parser.test.ts)
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

// Mock 402index response server handler — returns a single L402 endpoint
// whose WWW-Authenticate carries the BOLT11 fixture.
function mockFetchFactory(invoiceToReturn: string): typeof fetch {
  const fakeFetch: typeof fetch = async (input: string | URL | Request, init?: RequestInit) => {
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

describe('Voie 1 — registryCrawler alimente preimage_pool (tier=medium, source=crawler)', () => {
  let db: Database.Database;
  let serviceEndpointRepo: ServiceEndpointRepository;
  let preimagePoolRepo: PreimagePoolRepository;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    serviceEndpointRepo = new ServiceEndpointRepository(db);
    preimagePoolRepo = new PreimagePoolRepository(db);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    db.close();
  });

  it('insère le payment_hash du BOLT11 découvert avec tier=medium, source=crawler', async () => {
    global.fetch = mockFetchFactory(MAINNET_INVOICE);
    const decodeBolt11 = async () => ({ destination: '02' + 'a'.repeat(64), num_satoshis: '2000' });
    const crawler = new RegistryCrawler(serviceEndpointRepo, decodeBolt11, preimagePoolRepo);
    await crawler.run();

    const entry = preimagePoolRepo.findByPaymentHash(MAINNET_PAYMENT_HASH);
    expect(entry).not.toBeNull();
    expect(entry?.confidence_tier).toBe('medium');
    expect(entry?.source).toBe('crawler');
    expect(entry?.bolt11_raw).toBe(MAINNET_INVOICE);
    expect(entry?.consumed_at).toBeNull();
  });

  it('est idempotent — un second run ne modifie pas le tier/source', async () => {
    global.fetch = mockFetchFactory(MAINNET_INVOICE);
    const decodeBolt11 = async () => ({ destination: '02' + 'a'.repeat(64), num_satoshis: '2000' });
    const crawler = new RegistryCrawler(serviceEndpointRepo, decodeBolt11, preimagePoolRepo);
    await crawler.run();
    await crawler.run();

    const counts = preimagePoolRepo.countByTier();
    expect(counts.medium).toBe(1);
    expect(counts.low).toBe(0);
  });
});

describe('Voie 2 — /api/decide avec bolt11Raw alimente preimage_pool (tier=medium, source=intent)', () => {
  let db: Database.Database;
  let app: express.Express;
  let preimagePoolRepo: PreimagePoolRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const agentRepo = new AgentRepository(db);
    const txRepo = new TransactionRepository(db);
    const attestationRepo = new AttestationRepository(db);
    const snapshotRepo = new SnapshotRepository(db);
    const probeRepo = new ProbeRepository(db);
    preimagePoolRepo = new PreimagePoolRepository(db);
    const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, probeRepo);
    const trendService = new TrendService(agentRepo, snapshotRepo);
    const riskService = new RiskService();
    const verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, riskService, probeRepo);
    const decideService = new DecideService({ agentRepo, attestationRepo, scoringService, trendService, riskService, verdictService, probeRepo });
    const reportService = new ReportService(attestationRepo, agentRepo, txRepo, scoringService, db, 'off');
    const agentService = new AgentService(agentRepo, txRepo, attestationRepo, scoringService, trendService, snapshotRepo, probeRepo);

    const v2 = new V2Controller(
      decideService, reportService, agentService, agentRepo, attestationRepo, scoringService,
      trendService, riskService, probeRepo, undefined, undefined, undefined, verdictService,
      undefined, db, undefined, preimagePoolRepo,
    );

    // Fixtures : target + caller
    const target = makeAgent('target-voie2', { public_key_hash: sha256('target-voie2') });
    const caller = makeAgent('caller-voie2', { public_key_hash: sha256('caller-voie2') });
    agentRepo.insert(target);
    agentRepo.insert(caller);
    scoringService.computeScore(target.public_key_hash);

    app = express();
    app.use(express.json());
    app.post('/api/decide', v2.decide);
    app.use(errorHandler);
  });

  afterEach(() => db.close());

  it('insère le payment_hash avec tier=medium, source=intent', async () => {
    const res = await request(app).post('/api/decide').send({
      target: sha256('target-voie2'),
      caller: sha256('caller-voie2'),
      bolt11Raw: MAINNET_INVOICE,
    });
    expect(res.status).toBe(200);

    const entry = preimagePoolRepo.findByPaymentHash(MAINNET_PAYMENT_HASH);
    expect(entry).not.toBeNull();
    expect(entry?.confidence_tier).toBe('medium');
    expect(entry?.source).toBe('intent');
    expect(entry?.bolt11_raw).toBe(MAINNET_INVOICE);
  });

  it('ne crée pas d\'entrée si bolt11Raw absent', async () => {
    const res = await request(app).post('/api/decide').send({
      target: sha256('target-voie2'),
      caller: sha256('caller-voie2'),
    });
    expect(res.status).toBe(200);
    expect(preimagePoolRepo.countByTier()).toEqual({ high: 0, medium: 0, low: 0 });
  });

  it('rejette BOLT11 malformé au niveau zod (400)', async () => {
    const res = await request(app).post('/api/decide').send({
      target: sha256('target-voie2'),
      caller: sha256('caller-voie2'),
      bolt11Raw: 'not-a-valid-invoice',
    });
    expect(res.status).toBe(400);
    expect(preimagePoolRepo.countByTier()).toEqual({ high: 0, medium: 0, low: 0 });
  });
});
