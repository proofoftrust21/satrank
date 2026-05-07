// AEPS HTTP routes — integration tests against real Postgres.
//
// Validates the §8.5 observer routes end-to-end : POST observation
// triggers fork detection when a 2nd distinct root is recorded for the
// same (operator, day), and the routes return correct shapes.
//
// Disputes + multi-hop routes need NIP-98 auth + bond setup ; integration
// coverage for those is a follow-up. The observer routes are
// permissionless so this file exercises them without auth scaffolding.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import request from 'supertest';
import express from 'express';
import { AepsObserverRepository } from '../repositories/aepsObserverRepository';
import { ForkDetectionService } from '../services/forkDetectionService';
import { AepsObserverController } from '../controllers/aepsObserverController';
import { createAepsObserverRoutes } from '../routes/aepsObserver';
import { DailyMerkleAnchorRepository } from '../repositories/dailyMerkleAnchorRepository';
import { DailyMerkleAnchorService } from '../services/dailyMerkleAnchorService';
import { AepsEvidenceController } from '../controllers/aepsEvidenceController';
import { createAepsEvidenceRoutes } from '../routes/aepsEvidence';

let testDb: TestDb;

const OPERATOR_A = 'aa'.repeat(32);
const OPERATOR_B = 'bb'.repeat(32);
const ROOT_X = '11'.repeat(32);
const ROOT_Y = '22'.repeat(32);
const ROOT_Z = '33'.repeat(32);

async function buildAepsApp() {
  testDb = await setupTestPool();
  const pool = testDb.pool;

  const observerRepo = new AepsObserverRepository(pool);
  const forkService = new ForkDetectionService({ repo: observerRepo });
  const observerController = new AepsObserverController({
    forkService,
    observerRepo,
  });

  const anchorRepo = new DailyMerkleAnchorRepository(pool);
  // For evidence routes, use OPERATOR_A as the operator pubkey (since
  // signerService isn't configured in tests, we pass it explicitly).
  const anchorService = new DailyMerkleAnchorService({
    repo: anchorRepo,
    operatorPubkeyHex: OPERATOR_A,
  });
  const evidenceController = new AepsEvidenceController({
    anchorService,
    anchorRepo,
    operatorPubkeyHex: OPERATOR_A,
  });

  const app = express();
  app.use(express.json());
  const api = express.Router();
  api.use('/aeps', createAepsObserverRoutes(observerController));
  api.use('/aeps', createAepsEvidenceRoutes(evidenceController));
  app.use('/api', api);

  return { app, pool, observerRepo, anchorRepo, anchorService, forkService };
}

describe('AEPS HTTP routes — integration', () => {
  let app: express.Express;
  let anchorService: DailyMerkleAnchorService;

  beforeAll(async () => {
    const built = await buildAepsApp();
    app = built.app;
    anchorService = built.anchorService;
  });

  afterAll(async () => {
    if (testDb) await teardownTestPool(testDb);
  });

  beforeEach(async () => {
    await truncateAll(testDb.pool);
  });

  describe('POST /api/aeps/observation', () => {
    it('records observation and returns 201 with fork_detected=false on first observation', async () => {
      const res = await request(app)
        .post('/api/aeps/observation')
        .send({
          operator_pubkey: OPERATOR_A,
          day_utc: '2026-05-08',
          root_hex: ROOT_X,
          source: 'manual',
        });
      expect(res.status).toBe(201);
      expect(res.body.data.fork_detected).toBe(false);
      expect(res.body.data.observation_id).toBeGreaterThan(0);
      expect(res.body.data.fork_event_id).toBeNull();
    });

    it('rejects malformed operator_pubkey with 400', async () => {
      const res = await request(app)
        .post('/api/aeps/observation')
        .send({
          operator_pubkey: 'too-short',
          day_utc: '2026-05-08',
          root_hex: ROOT_X,
          source: 'manual',
        });
      expect(res.status).toBe(400);
    });

    it('rejects malformed day_utc', async () => {
      const res = await request(app)
        .post('/api/aeps/observation')
        .send({
          operator_pubkey: OPERATOR_A,
          day_utc: '2026-5-8',
          root_hex: ROOT_X,
          source: 'manual',
        });
      expect(res.status).toBe(400);
    });

    it('rejects unknown source', async () => {
      const res = await request(app)
        .post('/api/aeps/observation')
        .send({
          operator_pubkey: OPERATOR_A,
          day_utc: '2026-05-08',
          root_hex: ROOT_X,
          source: 'made-up',
        });
      expect(res.status).toBe(400);
    });

    it('triggers fork detection when 2nd distinct root recorded for same operator+day', async () => {
      // First observation : ROOT_X via 'self'
      const r1 = await request(app)
        .post('/api/aeps/observation')
        .send({
          operator_pubkey: OPERATOR_A,
          day_utc: '2026-05-08',
          root_hex: ROOT_X,
          source: 'self',
        });
      expect(r1.status).toBe(201);
      expect(r1.body.data.fork_detected).toBe(false);

      // Second observation : ROOT_Y via 'l1' source — same op+day, different root → FORK
      const r2 = await request(app)
        .post('/api/aeps/observation')
        .send({
          operator_pubkey: OPERATOR_A,
          day_utc: '2026-05-08',
          root_hex: ROOT_Y,
          source: 'l1',
          source_ref: 'tx_abc',
        });
      expect(r2.status).toBe(201);
      expect(r2.body.data.fork_detected).toBe(true);
      expect(r2.body.data.fork_event_id).toBeGreaterThan(0);
    });

    it('idempotent : same observation twice does not double-record', async () => {
      // PG's UNIQUE constraint treats NULL as distinct, so source_ref MUST
      // be specified for idempotency to apply. The whitepaper §8.5 says
      // observations are idempotent on (operator, day, root, source,
      // source_ref) ; callers wanting deduplication pass a stable ref.
      const obs = {
        operator_pubkey: OPERATOR_A,
        day_utc: '2026-05-08',
        root_hex: ROOT_X,
        source: 'self' as const,
        source_ref: 'fixed_ref',
      };
      const r1 = await request(app).post('/api/aeps/observation').send(obs);
      const r2 = await request(app).post('/api/aeps/observation').send(obs);
      expect(r1.body.data.observation_id).toBe(r2.body.data.observation_id);
    });
  });

  describe('GET /api/aeps/forks', () => {
    it('returns empty list when no forks detected', async () => {
      const res = await request(app).get('/api/aeps/forks');
      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(0);
      expect(res.body.data.forks).toEqual([]);
    });

    it('returns detected forks after equivocation', async () => {
      await request(app).post('/api/aeps/observation').send({
        operator_pubkey: OPERATOR_A, day_utc: '2026-05-08', root_hex: ROOT_X, source: 'self',
      });
      await request(app).post('/api/aeps/observation').send({
        operator_pubkey: OPERATOR_A, day_utc: '2026-05-08', root_hex: ROOT_Y, source: 'l1', source_ref: 'tx',
      });

      const res = await request(app).get('/api/aeps/forks');
      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(1);
      expect(res.body.data.forks[0].operator_pubkey).toBe(OPERATOR_A);
      expect(res.body.data.forks[0].day_utc).toBe('2026-05-08');
      // Roots stored in lex order
      expect(res.body.data.forks[0].root_hex_a).toBe(ROOT_X);
      expect(res.body.data.forks[0].root_hex_b).toBe(ROOT_Y);
    });

    it('filters by operator_pubkey query param', async () => {
      // Setup : fork on OPERATOR_A and on OPERATOR_B
      await request(app).post('/api/aeps/observation').send({
        operator_pubkey: OPERATOR_A, day_utc: '2026-05-08', root_hex: ROOT_X, source: 'self',
      });
      await request(app).post('/api/aeps/observation').send({
        operator_pubkey: OPERATOR_A, day_utc: '2026-05-08', root_hex: ROOT_Y, source: 'l1', source_ref: 'a',
      });
      await request(app).post('/api/aeps/observation').send({
        operator_pubkey: OPERATOR_B, day_utc: '2026-05-08', root_hex: ROOT_X, source: 'self',
      });
      await request(app).post('/api/aeps/observation').send({
        operator_pubkey: OPERATOR_B, day_utc: '2026-05-08', root_hex: ROOT_Z, source: 'l1', source_ref: 'b',
      });

      const all = await request(app).get('/api/aeps/forks');
      expect(all.body.data.count).toBe(2);

      const aOnly = await request(app).get(`/api/aeps/forks?operator_pubkey=${OPERATOR_A}`);
      expect(aOnly.body.data.count).toBe(1);
      expect(aOnly.body.data.forks[0].operator_pubkey).toBe(OPERATOR_A);
    });
  });

  describe('GET /api/aeps/observations/:operator_pubkey/:day_utc', () => {
    it('returns observations grouped by root', async () => {
      await request(app).post('/api/aeps/observation').send({
        operator_pubkey: OPERATOR_A, day_utc: '2026-05-08', root_hex: ROOT_X, source: 'self',
      });
      await request(app).post('/api/aeps/observation').send({
        operator_pubkey: OPERATOR_A, day_utc: '2026-05-08', root_hex: ROOT_Y, source: 'l1', source_ref: 'tx',
      });
      const res = await request(app).get(`/api/aeps/observations/${OPERATOR_A}/2026-05-08`);
      expect(res.status).toBe(200);
      expect(res.body.data.distinct_roots).toBe(2);
      expect(Object.keys(res.body.data.observations_by_root).sort()).toEqual([ROOT_X, ROOT_Y]);
    });

    it('returns empty bucket when no observations', async () => {
      const res = await request(app).get(`/api/aeps/observations/${OPERATOR_A}/2026-05-08`);
      expect(res.status).toBe(200);
      expect(res.body.data.distinct_roots).toBe(0);
    });

    it('rejects malformed operator_pubkey', async () => {
      const res = await request(app).get('/api/aeps/observations/too-short/2026-05-08');
      expect(res.status).toBe(400);
    });

    it('rejects malformed day_utc', async () => {
      const res = await request(app).get(`/api/aeps/observations/${OPERATOR_A}/not-a-date`);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/aeps/anchor/:day_utc', () => {
    it('returns 404 when no anchor for that day', async () => {
      const res = await request(app).get('/api/aeps/anchor/2026-05-08');
      expect(res.status).toBe(404);
    });

    it('returns anchor after computeAndPersist', async () => {
      // No write endpoint for evidence_receipts without NIP-98 auth, so we
      // drive computeAndPersist directly. The empty-bucket case still
      // exercises the read endpoint + canonical empty-Merkle root.
      const result = await anchorService.computeAndPersist('2026-05-08');
      expect(result.status).toBe('no_receipts');
      const res = await request(app).get('/api/aeps/anchor/2026-05-08');
      expect(res.status).toBe(200);
      expect(res.body.data.day_utc).toBe('2026-05-08');
      expect(res.body.data.operator_pubkey).toBe(OPERATOR_A);
      expect(res.body.data.receipt_count).toBe(0);
      expect(res.body.data.root_hex).toMatch(/^[0-9a-f]{64}$/);
      // RFC 6962 empty-tree root = SHA-256('')
      expect(res.body.data.root_hex).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
    });

    it('rejects malformed day_utc', async () => {
      const res = await request(app).get('/api/aeps/anchor/2026-5-8');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/aeps/anchor/recent', () => {
    it('returns empty list when no anchors', async () => {
      const res = await request(app).get('/api/aeps/anchor/recent');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('GET /api/aeps/proof/:receipt_id', () => {
    it('returns 404 when receipt not found', async () => {
      const res = await request(app).get('/api/aeps/proof/9999');
      expect(res.status).toBe(404);
    });

    it('rejects non-positive receipt_id', async () => {
      const res = await request(app).get('/api/aeps/proof/0');
      expect(res.status).toBe(400);
    });

    it('rejects non-integer receipt_id', async () => {
      const res = await request(app).get('/api/aeps/proof/not-a-number');
      expect(res.status).toBe(400);
    });
  });
});
