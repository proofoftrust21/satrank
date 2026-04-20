// Phase 7 — tests d'intégration HTTP pour POST /api/operator/register.
//
// Couverture :
//   - NIP-98 gate (header manquant → 401, event forgé → 401)
//   - Body zod validation (operator_id absent/invalide → 400)
//   - LN signature valide → identity verified
//   - LN signature invalide → identity claim mais non-verified
//   - NIP-05 valide (via fetcher stub) → identity verified
//   - DNS TXT valide (via resolver stub) → identity verified
//   - 2/3 preuves → status='verified' + score=2
//   - Ownerships claim persisté (node/endpoint/service)
//   - rawBody binding : body modifié après sign → 401
import { webcrypto } from 'node:crypto';
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto: unknown }).crypto = webcrypto;
}
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import request from 'supertest';
import express from 'express';
import { runMigrations } from '../database/migrations';
import {
  OperatorRepository,
  OperatorIdentityRepository,
  OperatorOwnershipRepository,
} from '../repositories/operatorRepository';
import { OperatorService } from '../services/operatorService';
import {
  EndpointStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import { OperatorController } from '../controllers/operatorController';
import { errorHandler } from '../middleware/errorHandler';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { buildLnChallenge } from '../services/operatorVerificationService';
// @ts-expect-error — ESM subpath
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Helper — signe un event NIP-98 pour la requête HTTP donnée.
function signNip98(url: string, method: string, body: string): string {
  const sk = generateSecretKey();
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
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
  const signed = finalizeEvent(template, sk);
  return `Nostr ${Buffer.from(JSON.stringify(signed)).toString('base64')}`;
}

// Helper — construit l'app Express avec le OperatorController câblé.
interface Ctx {
  db: Database.Database;
  app: express.Express;
  operators: OperatorRepository;
  identities: OperatorIdentityRepository;
  ownerships: OperatorOwnershipRepository;
}

function setup(options?: {
  nostrJsonFetcher?: (url: string) => Promise<Record<string, unknown> | null>;
  dnsTxtResolver?: (hostname: string) => Promise<string[][]>;
}): Ctx {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const operators = new OperatorRepository(db);
  const identities = new OperatorIdentityRepository(db);
  const ownerships = new OperatorOwnershipRepository(db);
  const endpointPosteriors = new EndpointStreamingPosteriorRepository(db);
  const nodePosteriors = new NodeStreamingPosteriorRepository(db);
  const servicePosteriors = new ServiceStreamingPosteriorRepository(db);
  const service = new OperatorService(
    operators,
    identities,
    ownerships,
    endpointPosteriors,
    nodePosteriors,
    servicePosteriors,
  );
  const controller = new OperatorController({
    operatorService: service,
    nostrJsonFetcher: options?.nostrJsonFetcher,
    dnsTxtResolver: options?.dnsTxtResolver,
  });

  const app = express();
  app.use(express.json({
    verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
      if (buf && buf.length > 0) req.rawBody = Buffer.from(buf);
    },
  }));
  app.post('/api/operator/register', controller.register);
  app.use(errorHandler);

  return { db, app, operators, identities, ownerships };
}

const BASE_URL = 'http://127.0.0.1:80';
const REGISTER_URL = `${BASE_URL}/api/operator/register`;

describe('POST /api/operator/register — NIP-98 gate', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it('rejette sans header Authorization (401 NIP98_INVALID)', async () => {
    const res = await request(ctx.app)
      .post('/api/operator/register')
      .set('Host', '127.0.0.1:80')
      .send({ operator_id: 'op-abc' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('NIP98_INVALID');
  });

  it('rejette un header Nostr malformé (401)', async () => {
    const res = await request(ctx.app)
      .post('/api/operator/register')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', 'Nostr not-valid-base64!@@')
      .send({ operator_id: 'op-abc' });
    expect(res.status).toBe(401);
  });

  it('rejette body modifié après sign (payload_mismatch → 401)', async () => {
    const signedBody = JSON.stringify({ operator_id: 'op-victim' });
    const auth = signNip98(REGISTER_URL, 'POST', signedBody);
    // On envoie un body différent de celui qui a été signé.
    const res = await request(ctx.app)
      .post('/api/operator/register')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send('{"operator_id":"op-attacker"}');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/operator/register — body validation', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it('rejette operator_id absent (400 VALIDATION_ERROR)', async () => {
    const body = JSON.stringify({});
    const auth = signNip98(REGISTER_URL, 'POST', body);
    const res = await request(ctx.app)
      .post('/api/operator/register')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejette operator_id avec caractères invalides (400)', async () => {
    const body = JSON.stringify({ operator_id: 'bad id with spaces' });
    const auth = signNip98(REGISTER_URL, 'POST', body);
    const res = await request(ctx.app)
      .post('/api/operator/register')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(400);
  });

  it('accepte un register minimal (operator_id seul) → crée pending', async () => {
    const body = JSON.stringify({ operator_id: 'op-solo' });
    const auth = signNip98(REGISTER_URL, 'POST', body);
    const res = await request(ctx.app)
      .post('/api/operator/register')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(201);
    expect(res.body.data.operator_id).toBe('op-solo');
    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.verification_score).toBe(0);
    expect(ctx.operators.findById('op-solo')!.status).toBe('pending');
  });
});

describe('POST /api/operator/register — identity verification', () => {
  it('LN signature valide → identity verified + score=1', async () => {
    const ctx = setup();
    try {
      const { secretKey, publicKey } = secp256k1.keygen();
      const pubkeyHex = bytesToHex(publicKey);
      const operatorId = 'op-ln-ok';
      const challenge = buildLnChallenge(operatorId);
      const sig = secp256k1.sign(new TextEncoder().encode(challenge), secretKey);

      const body = JSON.stringify({
        operator_id: operatorId,
        identities: [
          { type: 'ln_pubkey', value: pubkeyHex, signature_hex: bytesToHex(sig) },
        ],
      });
      const auth = signNip98(REGISTER_URL, 'POST', body);
      const res = await request(ctx.app)
        .post('/api/operator/register')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.data.verification_score).toBe(1);
      expect(res.body.data.verifications[0].valid).toBe(true);
      // 1 preuve seule → reste pending (seuil 2/3 non atteint)
      expect(res.body.data.status).toBe('pending');
    } finally {
      ctx.db.close();
    }
  });

  it('LN signature invalide → identity claim mais non-verified', async () => {
    const ctx = setup();
    try {
      const { publicKey } = secp256k1.keygen();
      const pubkeyHex = bytesToHex(publicKey);
      const body = JSON.stringify({
        operator_id: 'op-ln-bad',
        identities: [
          // Signature bidon — 128 hex chars mais faux
          { type: 'ln_pubkey', value: pubkeyHex, signature_hex: '00'.repeat(64) },
        ],
      });
      const auth = signNip98(REGISTER_URL, 'POST', body);
      const res = await request(ctx.app)
        .post('/api/operator/register')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.data.verification_score).toBe(0);
      expect(res.body.data.verifications[0].valid).toBe(false);
      // L'identity est claim en DB mais non-verified
      const ids = ctx.identities.findByOperator('op-ln-bad');
      expect(ids).toHaveLength(1);
      expect(ids[0].verified_at).toBeNull();
    } finally {
      ctx.db.close();
    }
  });

  it('NIP-05 valide (via fetcher stub) → identity verified', async () => {
    const pubkey = 'a'.repeat(64);
    const ctx = setup({
      nostrJsonFetcher: async () => ({ names: { alice: pubkey } }),
    });
    try {
      const body = JSON.stringify({
        operator_id: 'op-nip05-ok',
        identities: [
          { type: 'nip05', value: 'alice@example.com', expected_pubkey: pubkey },
        ],
      });
      const auth = signNip98(REGISTER_URL, 'POST', body);
      const res = await request(ctx.app)
        .post('/api/operator/register')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.data.verifications[0].valid).toBe(true);
      expect(res.body.data.verification_score).toBe(1);
    } finally {
      ctx.db.close();
    }
  });

  it('NIP-05 sans expected_pubkey → verified=false (expected_pubkey_missing)', async () => {
    const ctx = setup();
    try {
      const body = JSON.stringify({
        operator_id: 'op-nip05-no-pk',
        identities: [
          { type: 'nip05', value: 'alice@example.com' },
        ],
      });
      const auth = signNip98(REGISTER_URL, 'POST', body);
      const res = await request(ctx.app)
        .post('/api/operator/register')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.data.verifications[0].valid).toBe(false);
      expect(res.body.data.verifications[0].reason).toBe('expected_pubkey_missing');
    } finally {
      ctx.db.close();
    }
  });

  it('DNS TXT valide (via resolver stub) → identity verified', async () => {
    const operatorId = 'op-dns-ok';
    const ctx = setup({
      dnsTxtResolver: async () => [[`satrank-operator=${operatorId}`]],
    });
    try {
      const body = JSON.stringify({
        operator_id: operatorId,
        identities: [
          { type: 'dns', value: 'example.com' },
        ],
      });
      const auth = signNip98(REGISTER_URL, 'POST', body);
      const res = await request(ctx.app)
        .post('/api/operator/register')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.data.verifications[0].valid).toBe(true);
    } finally {
      ctx.db.close();
    }
  });

  it('2 preuves convergentes (LN + NIP-05) → status=verified, score=2', async () => {
    const { secretKey, publicKey } = secp256k1.keygen();
    const pubkeyHex = bytesToHex(publicKey);
    const operatorId = 'op-multi-verified';
    const challenge = buildLnChallenge(operatorId);
    const sig = secp256k1.sign(new TextEncoder().encode(challenge), secretKey);
    const nostrPubkey = 'b'.repeat(64);

    const ctx = setup({
      nostrJsonFetcher: async () => ({ names: { alice: nostrPubkey } }),
    });
    try {
      const body = JSON.stringify({
        operator_id: operatorId,
        identities: [
          { type: 'ln_pubkey', value: pubkeyHex, signature_hex: bytesToHex(sig) },
          { type: 'nip05', value: 'alice@example.com', expected_pubkey: nostrPubkey },
        ],
      });
      const auth = signNip98(REGISTER_URL, 'POST', body);
      const res = await request(ctx.app)
        .post('/api/operator/register')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('verified');
      expect(res.body.data.verification_score).toBe(2);
      expect(res.body.data.verifications).toHaveLength(2);
      expect(res.body.data.verifications.every((v: { valid: boolean }) => v.valid)).toBe(true);
    } finally {
      ctx.db.close();
    }
  });
});

describe('POST /api/operator/register — ownerships', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it('claim ownerships node/endpoint/service persiste en pending', async () => {
    const body = JSON.stringify({
      operator_id: 'op-with-resources',
      ownerships: [
        { type: 'node', id: 'pk-node-1' },
        { type: 'endpoint', id: 'url-hash-1' },
        { type: 'service', id: 'svc-hash-1' },
      ],
    });
    const auth = signNip98(REGISTER_URL, 'POST', body);
    const res = await request(ctx.app)
      .post('/api/operator/register')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.data.catalog.ownedNodes).toHaveLength(1);
    expect(res.body.data.catalog.ownedEndpoints).toHaveLength(1);
    expect(res.body.data.catalog.ownedServices).toHaveLength(1);
    // verified_at reste NULL (pending)
    expect(res.body.data.catalog.ownedNodes[0].verified_at).toBeNull();
  });

  it('register est idempotent sur operator_id + identity triplet', async () => {
    const body1 = JSON.stringify({
      operator_id: 'op-idempotent',
      identities: [{ type: 'dns', value: 'example.com' }],
    });
    const auth1 = signNip98(REGISTER_URL, 'POST', body1);
    await request(ctx.app).post('/api/operator/register')
      .set('Host', '127.0.0.1:80').set('Authorization', auth1)
      .set('Content-Type', 'application/json').send(body1);

    // Deuxième register avec même operator_id + même identity
    const body2 = JSON.stringify({
      operator_id: 'op-idempotent',
      identities: [{ type: 'dns', value: 'example.com' }],
    });
    const auth2 = signNip98(REGISTER_URL, 'POST', body2);
    const res = await request(ctx.app).post('/api/operator/register')
      .set('Host', '127.0.0.1:80').set('Authorization', auth2)
      .set('Content-Type', 'application/json').send(body2);

    expect(res.status).toBe(201);
    // Pas de duplication
    expect(ctx.identities.findByOperator('op-idempotent')).toHaveLength(1);
  });
});
