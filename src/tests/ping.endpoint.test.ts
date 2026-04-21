// Ping endpoint tests — real-time reachability check
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import request from 'supertest';
import express, { Router } from 'express';
import { PingController } from '../controllers/pingController';
import { createPingRoutes } from '../routes/ping';
import { errorHandler } from '../middleware/errorHandler';
import type { LndGraphClient, LndQueryRoutesResponse } from '../crawler/lndGraphClient';

// Mock LND client
function makeMockLnd(response: LndQueryRoutesResponse): LndGraphClient {
  return {
    getInfo: async () => ({ synced_to_graph: true, identity_pubkey: '02aaa', alias: 'mock', num_active_channels: 1, num_peers: 1, block_height: 800000 }),
    getGraph: async () => ({ nodes: [], edges: [] }),
    getNodeInfo: async () => null,
    queryRoutes: async () => response,
  };
}

const VALID_PUBKEY = '02' + 'aa'.repeat(32);
const VALID_FROM = '03' + 'bb'.repeat(32);

let app: express.Express;
let testDb: TestDb;
let db: Pool;

describe('GET /api/ping/:pubkey', async () => {
  describe('with reachable route', async () => {
    beforeAll(async () => {
      testDb = await setupTestPool();

      db = testDb.pool;
    const mockLnd = makeMockLnd({
        routes: [{
          total_time_lock: 100,
          total_fees: '5',
          total_fees_msat: '5000',
          total_amt: '1005',
          total_amt_msat: '1005000',
          hops: [
            { chan_id: '1', chan_capacity: '1000000', amt_to_forward: '1000', fee: '3', fee_msat: '3000', pub_key: '02ccc' },
            { chan_id: '2', chan_capacity: '500000', amt_to_forward: '1000', fee: '2', fee_msat: '2000', pub_key: VALID_PUBKEY },
          ],
        }],
      });

      app = express();
      app.use(express.json());
      const api = Router();
      api.use(createPingRoutes(new PingController(mockLnd)));
      app.use('/api', api);
      app.use(errorHandler);
    });

    afterAll(async () => { await teardownTestPool(testDb); });

    it('returns reachable with hops and fees', async () => {
      const res = await request(app).get(`/api/ping/${VALID_PUBKEY}`);
      expect(res.status).toBe(200);
      expect(res.body.data.reachable).toBe(true);
      expect(res.body.data.hops).toBe(2);
      expect(res.body.data.totalFeeMsat).toBe(5000);
      expect(res.body.data.routeFound).toBe(true);
      expect(res.body.data.fromCaller).toBe(false);
      expect(res.body.data.latencyMs).toBeGreaterThanOrEqual(0);
      expect(res.body.data.error).toBeNull();
    });

    it('accepts from parameter for personalized pathfinding', async () => {
      const res = await request(app).get(`/api/ping/${VALID_PUBKEY}?from=${VALID_FROM}`);
      expect(res.status).toBe(200);
      expect(res.body.data.fromCaller).toBe(true);
      expect(res.body.data.reachable).toBe(true);
    });
  });

  describe('with unreachable route', async () => {
    beforeAll(async () => {
      const mockLnd = makeMockLnd({ routes: [] });
      app = express();
      app.use(express.json());
      const api = Router();
      api.use(createPingRoutes(new PingController(mockLnd)));
      app.use('/api', api);
      app.use(errorHandler);
    });

    it('returns unreachable', async () => {
      const res = await request(app).get(`/api/ping/${VALID_PUBKEY}`);
      expect(res.status).toBe(200);
      expect(res.body.data.reachable).toBe(false);
      expect(res.body.data.routeFound).toBe(false);
      expect(res.body.data.hops).toBeNull();
      expect(res.body.data.error).toBe('no_route');
    });
  });

  describe('without LND', async () => {
    beforeAll(async () => {
      app = express();
      app.use(express.json());
      const api = Router();
      api.use(createPingRoutes(new PingController(undefined)));
      app.use('/api', api);
      app.use(errorHandler);
    });

    it('returns lnd_not_configured', async () => {
      const res = await request(app).get(`/api/ping/${VALID_PUBKEY}`);
      expect(res.status).toBe(200);
      expect(res.body.data.reachable).toBeNull();
      expect(res.body.data.error).toBe('lnd_not_configured');
    });
  });

  describe('validation', async () => {
    beforeAll(async () => {
      app = express();
      app.use(express.json());
      const api = Router();
      api.use(createPingRoutes(new PingController(undefined)));
      app.use('/api', api);
      app.use(errorHandler);
    });

    it('rejects invalid pubkey', async () => {
      const res = await request(app).get('/api/ping/not-a-pubkey');
      expect(res.status).toBe(400);
    });

    it('rejects 64-char hash (not a pubkey)', async () => {
      const res = await request(app).get(`/api/ping/${'a'.repeat(64)}`);
      expect(res.status).toBe(400);
    });

    it('rejects invalid from parameter', async () => {
      const res = await request(app).get(`/api/ping/${VALID_PUBKEY}?from=invalid`);
      expect(res.status).toBe(400);
    });
  });
});
