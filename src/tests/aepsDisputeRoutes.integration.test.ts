// AEPS §10 dispute HTTP routes — integration tests against real Postgres
// with REAL BIP-340 Schnorr signing on both NIP-98 auth AND outcome
// attestations. Validates the full stack : Express → controller →
// disputeService → AepsDisputeRepository → PG.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import request from 'supertest';
import express from 'express';
import crypto from 'node:crypto';
// @ts-expect-error — ESM subpath
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { schnorr } from '@noble/curves/secp256k1.js';
import { AepsDisputeRepository } from '../repositories/aepsDisputeRepository';
import { DisputeService, schnorrSignOutcome } from '../services/disputeService';
import { AepsDisputeController } from '../controllers/aepsDisputeController';
import { createAepsDisputeRoutes } from '../routes/aepsDispute';

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
): { auth: string; pubkey: string } {
  const secret = sk ?? generateSecretKey();
  const pubkey = getPublicKey(secret);
  const tags: string[][] = [
    ['u', url],
    ['method', method],
  ];
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
  };
}

interface OracleKey {
  skHex: string;
  pkHex: string;
}

function makeOracle(): OracleKey {
  const sk = crypto.randomBytes(32);
  const pk = schnorr.getPublicKey(sk);
  return {
    skHex: Buffer.from(sk).toString('hex'),
    pkHex: Buffer.from(pk).toString('hex'),
  };
}

async function buildDisputeApp() {
  testDb = await setupTestPool();
  const pool = testDb.pool;
  const disputeRepo = new AepsDisputeRepository(pool);
  const disputeService = new DisputeService({ repo: disputeRepo });
  const controller = new AepsDisputeController({
    disputeService,
    disputeRepo,
  });

  const app = express();
  // The controller relies on req.rawBody for NIP-98 payload-hash
  // verification. Express middleware that exposes it :
  app.use(express.json({
    verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }));
  const api = express.Router();
  api.use('/aeps', createAepsDisputeRoutes(controller));
  app.use('/api', api);

  return { app, pool, disputeRepo, disputeService };
}

describe('AEPS §10 dispute routes — integration', () => {
  let app: express.Express;
  let disputeRepo: AepsDisputeRepository;

  beforeAll(async () => {
    const built = await buildDisputeApp();
    app = built.app;
    disputeRepo = built.disputeRepo;
  });

  afterAll(async () => {
    if (testDb) await teardownTestPool(testDb);
  });

  beforeEach(async () => {
    await truncateAll(testDb.pool);
  });

  describe('POST /api/aeps/dispute', () => {
    it('opens a dispute with valid NIP-98 + body, returns dispute_id + outcome_messages', async () => {
      const oracles = [makeOracle(), makeOracle(), makeOracle()];
      const respondent = 'b'.repeat(64);
      const body = {
        respondent_pubkey: respondent,
        dispute_type: 'content_correctness',
        oracle_pubkeys: oracles.map(o => o.pkHex),
        oracle_threshold: 2,
      };
      const url = `${BASE_URL}/api/aeps/dispute`;
      const { auth } = signNip98(url, 'POST', JSON.stringify(body));
      const res = await request(app)
        .post('/api/aeps/dispute')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .send(body);
      expect(res.status).toBe(201);
      expect(res.body.data.dispute_id).toMatch(/^dis_[0-9a-f]{32}$/);
      expect(res.body.data.multiplier).toBe(5);
      expect(res.body.data.oracle_threshold).toBe(2);
      expect(res.body.data.outcome_messages.disputant_wins.canonical).toContain('disputant_wins');
      expect(res.body.data.outcome_messages.disputant_wins.hash_hex).toMatch(/^[0-9a-f]{64}$/);
      expect(res.body.data.outcome_messages.respondent_wins.hash_hex).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejects missing NIP-98 with 401 invalid_auth', async () => {
      const res = await request(app)
        .post('/api/aeps/dispute')
        .send({
          respondent_pubkey: 'b'.repeat(64),
          dispute_type: 'fork',
          oracle_pubkeys: [makeOracle().pkHex],
          oracle_threshold: 1,
        });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_auth');
    });

    it('rejects threshold > oracle_pubkeys.length', async () => {
      const oracles = [makeOracle()];
      const body = {
        respondent_pubkey: 'b'.repeat(64),
        dispute_type: 'fork',
        oracle_pubkeys: oracles.map(o => o.pkHex),
        oracle_threshold: 5,
      };
      const url = `${BASE_URL}/api/aeps/dispute`;
      const { auth } = signNip98(url, 'POST', JSON.stringify(body));
      const res = await request(app)
        .post('/api/aeps/dispute')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .send(body);
      expect(res.status).toBe(400);
    });

    it('rejects same disputant + respondent', async () => {
      // The disputant pubkey comes from NIP-98. Set respondent to that pubkey.
      const url = `${BASE_URL}/api/aeps/dispute`;
      const sk = generateSecretKey();
      const myPk = getPublicKey(sk);
      const body = {
        respondent_pubkey: myPk,
        dispute_type: 'fork',
        oracle_pubkeys: [makeOracle().pkHex],
        oracle_threshold: 1,
      };
      const { auth } = signNip98(url, 'POST', JSON.stringify(body), sk);
      const res = await request(app)
        .post('/api/aeps/dispute')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .send(body);
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/aeps/dispute/:dispute_id/attestation', () => {
    async function openDispute(oracles: OracleKey[], threshold: number): Promise<string> {
      const body = {
        respondent_pubkey: 'b'.repeat(64),
        dispute_type: 'sla_breach',
        oracle_pubkeys: oracles.map(o => o.pkHex),
        oracle_threshold: threshold,
      };
      const url = `${BASE_URL}/api/aeps/dispute`;
      const { auth } = signNip98(url, 'POST', JSON.stringify(body));
      const res = await request(app)
        .post('/api/aeps/dispute')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .send(body);
      expect(res.status).toBe(201);
      return res.body.data.dispute_id;
    }

    it('accepts valid Schnorr attestation, resolves at threshold=1', async () => {
      const oracles = [makeOracle()];
      const disputeId = await openDispute(oracles, 1);
      const sig = schnorrSignOutcome(oracles[0].skHex, disputeId, 'disputant_wins');
      const body = { outcome: 'disputant_wins', signature_hex: sig };
      const attestUrl = `${BASE_URL}/api/aeps/dispute/${disputeId}/attestation`;
      // NIP-98 pubkey MUST equal oracle_pubkey — sign with the oracle's
      // secret key.
      const skBytes = Buffer.from(oracles[0].skHex, 'hex');
      const { auth } = signNip98(attestUrl, 'POST', JSON.stringify(body), skBytes);
      const res = await request(app)
        .post(`/api/aeps/dispute/${disputeId}/attestation`)
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .send(body);
      expect(res.status).toBe(200);
      expect(res.body.data.dispute_state).toBe('resolved_disputant');
    });

    it('rejects oracle not in dispute set with 403', async () => {
      const oracles = [makeOracle(), makeOracle()];
      const intruder = makeOracle();
      const disputeId = await openDispute(oracles, 2);
      const sig = schnorrSignOutcome(intruder.skHex, disputeId, 'disputant_wins');
      const body = { outcome: 'disputant_wins', signature_hex: sig };
      const attestUrl = `${BASE_URL}/api/aeps/dispute/${disputeId}/attestation`;
      const skBytes = Buffer.from(intruder.skHex, 'hex');
      const { auth } = signNip98(attestUrl, 'POST', JSON.stringify(body), skBytes);
      const res = await request(app)
        .post(`/api/aeps/dispute/${disputeId}/attestation`)
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .send(body);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('oracle_not_in_set');
    });

    it('rejects forged signature with 400 signature_invalid', async () => {
      const oracles = [makeOracle()];
      const disputeId = await openDispute(oracles, 1);
      // Signature by a DIFFERENT oracle but submitted with oracles[0]'s pubkey.
      const otherOracle = makeOracle();
      const forgedSig = schnorrSignOutcome(otherOracle.skHex, disputeId, 'disputant_wins');
      const body = { outcome: 'disputant_wins', signature_hex: forgedSig };
      const attestUrl = `${BASE_URL}/api/aeps/dispute/${disputeId}/attestation`;
      // NIP-98 sign with oracles[0] (the claimed oracle) — but the
      // outcome signature is from otherOracle ⇒ the controller verifies
      // schnorr.verify(forgedSig, msg, oracles[0].pk) which fails.
      const skBytes = Buffer.from(oracles[0].skHex, 'hex');
      const { auth } = signNip98(attestUrl, 'POST', JSON.stringify(body), skBytes);
      const res = await request(app)
        .post(`/api/aeps/dispute/${disputeId}/attestation`)
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('signature_invalid');
    });

    it('returns 404 dispute_not_found for unknown id', async () => {
      const fakeId = 'dis_' + 'aa'.repeat(16);
      const oracle = makeOracle();
      const sig = schnorrSignOutcome(oracle.skHex, fakeId, 'disputant_wins');
      const body = { outcome: 'disputant_wins', signature_hex: sig };
      const attestUrl = `${BASE_URL}/api/aeps/dispute/${fakeId}/attestation`;
      const skBytes = Buffer.from(oracle.skHex, 'hex');
      const { auth } = signNip98(attestUrl, 'POST', JSON.stringify(body), skBytes);
      const res = await request(app)
        .post(`/api/aeps/dispute/${fakeId}/attestation`)
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .send(body);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('dispute_not_found');
    });

    it('walks 2-of-3 threshold to resolution', async () => {
      const oracles = [makeOracle(), makeOracle(), makeOracle()];
      const disputeId = await openDispute(oracles, 2);
      // First attestation : disputed-wins from oracle 0 → still open
      let sig = schnorrSignOutcome(oracles[0].skHex, disputeId, 'disputant_wins');
      let body = { outcome: 'disputant_wins', signature_hex: sig };
      let url = `${BASE_URL}/api/aeps/dispute/${disputeId}/attestation`;
      let { auth } = signNip98(url, 'POST', JSON.stringify(body), Buffer.from(oracles[0].skHex, 'hex'));
      let res = await request(app)
        .post(`/api/aeps/dispute/${disputeId}/attestation`)
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .send(body);
      expect(res.status).toBe(200);
      expect(res.body.data.dispute_state).toBe('open');
      // Second attestation : same outcome from oracle 1 → resolves
      sig = schnorrSignOutcome(oracles[1].skHex, disputeId, 'disputant_wins');
      body = { outcome: 'disputant_wins', signature_hex: sig };
      ({ auth } = signNip98(url, 'POST', JSON.stringify(body), Buffer.from(oracles[1].skHex, 'hex')));
      res = await request(app)
        .post(`/api/aeps/dispute/${disputeId}/attestation`)
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .send(body);
      expect(res.status).toBe(200);
      expect(res.body.data.dispute_state).toBe('resolved_disputant');
    });

    it('detects oracle equivocation : same oracle, two outcomes', async () => {
      const oracles = [makeOracle(), makeOracle(), makeOracle()];
      const disputeId = await openDispute(oracles, 2);
      const url = `${BASE_URL}/api/aeps/dispute/${disputeId}/attestation`;
      // First : disputant_wins
      let sig = schnorrSignOutcome(oracles[0].skHex, disputeId, 'disputant_wins');
      let body = { outcome: 'disputant_wins', signature_hex: sig };
      let { auth } = signNip98(url, 'POST', JSON.stringify(body), Buffer.from(oracles[0].skHex, 'hex'));
      const r1 = await request(app)
        .post(`/api/aeps/dispute/${disputeId}/attestation`)
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .send(body);
      expect(r1.status).toBe(200);
      // Second : respondent_wins from SAME oracle = equivocation
      sig = schnorrSignOutcome(oracles[0].skHex, disputeId, 'respondent_wins');
      body = { outcome: 'respondent_wins', signature_hex: sig };
      ({ auth } = signNip98(url, 'POST', JSON.stringify(body), Buffer.from(oracles[0].skHex, 'hex'), Math.floor(Date.now() / 1000) + 1));
      const r2 = await request(app)
        .post(`/api/aeps/dispute/${disputeId}/attestation`)
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .send(body);
      expect(r2.status).toBe(200);
      // Verify the equivocation row was persisted
      const equiv = await disputeRepo.findEquivocation(oracles[0].pkHex.toLowerCase(), disputeId);
      expect(equiv).not.toBeNull();
      expect(equiv?.outcome_a).toBe('disputant_wins');
      expect(equiv?.outcome_b).toBe('respondent_wins');
      // Both signatures stored as evidence
      expect(equiv?.signature_hex_a).toMatch(/^[0-9a-f]{128}$/);
      expect(equiv?.signature_hex_b).toMatch(/^[0-9a-f]{128}$/);
    });
  });

  describe('GET /api/aeps/dispute/:dispute_id', () => {
    it('returns dispute state + attestation counts (public, no auth)', async () => {
      const oracles = [makeOracle(), makeOracle()];
      const body = {
        respondent_pubkey: 'b'.repeat(64),
        dispute_type: 'sla_breach',
        oracle_pubkeys: oracles.map(o => o.pkHex),
        oracle_threshold: 2,
      };
      const url = `${BASE_URL}/api/aeps/dispute`;
      const { auth } = signNip98(url, 'POST', JSON.stringify(body));
      const open = await request(app)
        .post('/api/aeps/dispute')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .send(body);
      const disputeId = open.body.data.dispute_id;

      // Submit one attestation
      const sig = schnorrSignOutcome(oracles[0].skHex, disputeId, 'disputant_wins');
      const attestBody = { outcome: 'disputant_wins', signature_hex: sig };
      const attestUrl = `${BASE_URL}/api/aeps/dispute/${disputeId}/attestation`;
      const { auth: attestAuth } = signNip98(
        attestUrl,
        'POST',
        JSON.stringify(attestBody),
        Buffer.from(oracles[0].skHex, 'hex'),
      );
      await request(app)
        .post(`/api/aeps/dispute/${disputeId}/attestation`)
        .set('Host', '127.0.0.1:80')
        .set('Authorization', attestAuth)
        .send(attestBody);

      // GET — no auth needed
      const get = await request(app).get(`/api/aeps/dispute/${disputeId}`);
      expect(get.status).toBe(200);
      expect(get.body.data.state).toBe('open'); // 1 of 2 threshold
      expect(get.body.data.attestation_counts.disputant_wins).toBe(1);
      expect(get.body.data.attestation_counts.respondent_wins).toBe(0);
      expect(get.body.data.attestations.length).toBe(1);
      expect(get.body.data.attestations[0].oracle_pubkey).toBe(oracles[0].pkHex.toLowerCase());
      expect(get.body.data.attestations[0].outcome).toBe('disputant_wins');
    });

    it('returns 404 for unknown dispute_id', async () => {
      const fakeId = 'dis_' + 'cc'.repeat(16);
      const res = await request(app).get(`/api/aeps/dispute/${fakeId}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('dispute_not_found');
    });

    it('rejects malformed dispute_id with 400', async () => {
      const res = await request(app).get('/api/aeps/dispute/not-a-dispute-id');
      expect(res.status).toBe(400);
    });
  });
});
