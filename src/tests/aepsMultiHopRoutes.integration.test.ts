// AEPS §6.3 multi-hop HTLC chain HTTP routes — integration tests against
// real Postgres with NIP-98 owner enforcement. Validates the chain state
// machine end-to-end : plan → lock × N → reveal → settle × N → complete.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import request from 'supertest';
import express from 'express';
import crypto from 'node:crypto';
// @ts-expect-error — ESM subpath
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { MultiHopChainRepository } from '../repositories/multiHopChainRepository';
import { MultiHopChainService } from '../services/multiHopChainService';
import { AepsMultiHopController } from '../controllers/aepsMultiHopController';
import { createAepsMultiHopRoutes } from '../routes/aepsMultiHop';

let testDb: TestDb;

const BASE_URL = 'http://127.0.0.1:80';

interface SignedEvent {
  id: string;
  pubkey: string;
  kind: number;
  tags: string[][];
  created_at: number;
  content: string;
  sig: string;
}

function signNip98(
  url: string,
  method: string,
  body: string,
  sk?: Uint8Array,
  createdAtSec?: number,
): { auth: string; pubkey: string; sk: Uint8Array } {
  const secret = sk ?? generateSecretKey();
  const pubkey = getPublicKey(secret);
  const tags: string[][] = [['u', url], ['method', method]];
  if (body.length > 0) {
    const hash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    tags.push(['payload', hash]);
  }
  const template = {
    kind: 27235,
    created_at: createdAtSec ?? Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
  const signed = finalizeEvent(template, secret) as SignedEvent;
  return {
    auth: `Nostr ${Buffer.from(JSON.stringify(signed)).toString('base64')}`,
    pubkey,
    sk: secret,
  };
}

async function buildMultiHopApp() {
  testDb = await setupTestPool();
  const pool = testDb.pool;
  const repo = new MultiHopChainRepository(pool);
  const service = new MultiHopChainService({ repo });
  const controller = new AepsMultiHopController({ service, repo });

  const app = express();
  app.use(express.json({
    verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }));
  const api = express.Router();
  api.use('/aeps', createAepsMultiHopRoutes(controller));
  app.use('/api', api);

  return { app, pool, repo, service };
}

const HEX64 = '00'.repeat(32);
function legSpec(i: number, opPubkey: string) {
  return {
    endpoint_id: `endpoint_${i}`,
    operator_pubkey: opPubkey,
    amount_msat: 1000,
    request_body_sha256: HEX64,
  };
}

describe('AEPS §6.3 multi-hop routes — integration', () => {
  let app: express.Express;

  beforeAll(async () => {
    const built = await buildMultiHopApp();
    app = built.app;
  });

  afterAll(async () => {
    if (testDb) await teardownTestPool(testDb);
  });

  beforeEach(async () => {
    await truncateAll(testDb.pool);
  });

  describe('POST /api/aeps/multihop/plan', () => {
    it('plans a 3-leg chain, returns preimage_hex (one-shot)', async () => {
      const operatorPk = 'b'.repeat(64);
      const body = {
        legs: [legSpec(0, operatorPk), legSpec(1, operatorPk), legSpec(2, operatorPk)],
      };
      const url = `${BASE_URL}/api/aeps/multihop/plan`;
      const { auth } = signNip98(url, 'POST', JSON.stringify(body));
      const res = await request(app)
        .post('/api/aeps/multihop/plan')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .send(body);
      expect(res.status).toBe(201);
      expect(res.body.data.chain_id).toMatch(/^mhc_[0-9a-f]{32}$/);
      expect(res.body.data.n_legs).toBe(3);
      expect(res.body.data.total_amount_msat).toBe(3000);
      expect(res.body.data.preimage_hex).toMatch(/^[0-9a-f]{64}$/);
      expect(res.body.data.preimage_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(res.body.data.state).toBe('planning');
    });

    it('rejects fewer than 2 legs', async () => {
      const body = { legs: [legSpec(0, 'b'.repeat(64))] };
      const url = `${BASE_URL}/api/aeps/multihop/plan`;
      const { auth } = signNip98(url, 'POST', JSON.stringify(body));
      const res = await request(app)
        .post('/api/aeps/multihop/plan')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .send(body);
      expect(res.status).toBe(400);
    });

    it('rejects missing NIP-98 with 401', async () => {
      const body = { legs: [legSpec(0, 'b'.repeat(64)), legSpec(1, 'b'.repeat(64))] };
      const res = await request(app).post('/api/aeps/multihop/plan').send(body);
      expect(res.status).toBe(401);
    });

    it('respects custom ttl_sec', async () => {
      const body = {
        legs: [legSpec(0, 'b'.repeat(64)), legSpec(1, 'b'.repeat(64))],
        ttl_sec: 300,
      };
      const url = `${BASE_URL}/api/aeps/multihop/plan`;
      const { auth } = signNip98(url, 'POST', JSON.stringify(body));
      const res = await request(app)
        .post('/api/aeps/multihop/plan')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .send(body);
      expect(res.status).toBe(201);
      const expiresIn = res.body.data.expires_at - Math.floor(Date.now() / 1000);
      expect(expiresIn).toBeGreaterThanOrEqual(290);
      expect(expiresIn).toBeLessThanOrEqual(310);
    });
  });

  describe('full lifecycle : plan → lock × N → reveal → settle × N → complete', () => {
    async function planChain(): Promise<{ chainId: string; preimageHex: string; sk: Uint8Array; agentPk: string }> {
      const opPk = 'b'.repeat(64);
      const body = { legs: [legSpec(0, opPk), legSpec(1, opPk), legSpec(2, opPk)] };
      const url = `${BASE_URL}/api/aeps/multihop/plan`;
      const { auth, sk, pubkey } = signNip98(url, 'POST', JSON.stringify(body));
      const res = await request(app)
        .post('/api/aeps/multihop/plan')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .send(body);
      expect(res.status).toBe(201);
      return {
        chainId: res.body.data.chain_id,
        preimageHex: res.body.data.preimage_hex,
        sk,
        agentPk: pubkey,
      };
    }

    async function ownerCall(chainId: string, suffix: string, sk: Uint8Array, body: object) {
      const url = `${BASE_URL}/api/aeps/multihop/${chainId}/${suffix}`;
      const { auth } = signNip98(url, 'POST', JSON.stringify(body), sk);
      return request(app)
        .post(`/api/aeps/multihop/${chainId}/${suffix}`)
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .send(body);
    }

    it('happy path : 3-leg chain settles atomically', async () => {
      const { chainId, preimageHex, sk } = await planChain();
      // Lock all 3 legs
      for (let i = 0; i < 3; i++) {
        const r = await ownerCall(chainId, 'lock', sk, { leg_index: i, htlc_ref: `htlc_${i}` });
        expect(r.status).toBe(200);
      }
      // After 3rd lock, chain transitions → 'locked'
      const stateAfterLock = await request(app).get(`/api/aeps/multihop/${chainId}`);
      expect(stateAfterLock.body.data.state).toBe('locked');
      // Reveal preimage
      const reveal = await ownerCall(chainId, 'reveal', sk, { preimage_hex: preimageHex });
      expect(reveal.status).toBe(200);
      // Settle all 3 legs (any order)
      for (let i = 2; i >= 0; i--) {
        const r = await ownerCall(chainId, 'settle', sk, { leg_index: i });
        expect(r.status).toBe(200);
      }
      // Final state : 'complete'
      const final = await request(app).get(`/api/aeps/multihop/${chainId}`);
      expect(final.body.data.state).toBe('complete');
      expect(final.body.data.preimage_revealed).toBe(preimageHex);
      expect(final.body.data.legs.every((l: { state: string }) => l.state === 'settled')).toBe(true);
    });

    it('rejects lock by non-owner with 401', async () => {
      const { chainId } = await planChain();
      // Use a fresh secret key — different agent
      const intruderSk = generateSecretKey();
      const r = await ownerCall(chainId, 'lock', intruderSk, { leg_index: 0, htlc_ref: 'h0' });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('invalid_auth');
    });

    it('rejects reveal with mismatched preimage', async () => {
      const { chainId, sk } = await planChain();
      // Lock all 3 first
      for (let i = 0; i < 3; i++) {
        await ownerCall(chainId, 'lock', sk, { leg_index: i, htlc_ref: `h${i}` });
      }
      // Wrong preimage
      const r = await ownerCall(chainId, 'reveal', sk, { preimage_hex: '00'.repeat(32) });
      expect(r.status).toBe(400);
    });

    it('rejects reveal before all legs locked', async () => {
      const { chainId, preimageHex, sk } = await planChain();
      await ownerCall(chainId, 'lock', sk, { leg_index: 0, htlc_ref: 'h0' });
      // Only 1 leg locked — chain still in 'planning'
      const r = await ownerCall(chainId, 'reveal', sk, { preimage_hex: preimageHex });
      expect(r.status).toBe(400);
    });

    it('abort moves chain to aborted, locks aborted legs', async () => {
      const { chainId, sk } = await planChain();
      await ownerCall(chainId, 'lock', sk, { leg_index: 0, htlc_ref: 'h0' });
      const r = await ownerCall(chainId, 'abort', sk, { reason: 'test_abort' });
      expect(r.status).toBe(200);
      expect(r.body.data.legs_aborted).toBe(3); // 1 locked + 2 planned
      const get = await request(app).get(`/api/aeps/multihop/${chainId}`);
      expect(get.body.data.state).toBe('aborted');
      expect(get.body.data.abort_reason).toBe('test_abort');
    });

    it('cannot abort a completed chain (already_terminal)', async () => {
      const { chainId, preimageHex, sk } = await planChain();
      for (let i = 0; i < 3; i++) {
        await ownerCall(chainId, 'lock', sk, { leg_index: i, htlc_ref: `h${i}` });
      }
      await ownerCall(chainId, 'reveal', sk, { preimage_hex: preimageHex });
      for (let i = 0; i < 3; i++) {
        await ownerCall(chainId, 'settle', sk, { leg_index: i });
      }
      const r = await ownerCall(chainId, 'abort', sk, { reason: 'too_late' });
      expect(r.status).toBe(400);
    });
  });

  describe('GET /api/aeps/multihop/:chain_id', () => {
    it('returns 400 for malformed chain_id', async () => {
      const r = await request(app).get('/api/aeps/multihop/not-a-chain-id');
      expect(r.status).toBe(400);
    });

    it('returns 404-ish (400 invalid_body with 404 status) for unknown chain', async () => {
      const fakeId = 'mhc_' + 'aa'.repeat(16);
      const r = await request(app).get(`/api/aeps/multihop/${fakeId}`);
      expect(r.status).toBe(404);
    });

    it('public read returns chain + legs (no auth required)', async () => {
      const opPk = 'b'.repeat(64);
      const body = { legs: [legSpec(0, opPk), legSpec(1, opPk)] };
      const url = `${BASE_URL}/api/aeps/multihop/plan`;
      const { auth } = signNip98(url, 'POST', JSON.stringify(body));
      const open = await request(app)
        .post('/api/aeps/multihop/plan')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .send(body);
      const chainId = open.body.data.chain_id;

      const r = await request(app).get(`/api/aeps/multihop/${chainId}`);
      expect(r.status).toBe(200);
      expect(r.body.data.chain_id).toBe(chainId);
      expect(r.body.data.n_legs).toBe(2);
      expect(r.body.data.legs.length).toBe(2);
      expect(r.body.data.legs[0].leg_index).toBe(0);
      expect(r.body.data.legs[1].leg_index).toBe(1);
      expect(r.body.data.preimage_revealed).toBeNull(); // not yet revealed
    });
  });
});
