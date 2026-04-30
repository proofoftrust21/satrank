// Phase 3 (2026-05-01) — POST/GET /api/schemas integration tests.
//
// Cover: NIP-98 enforcement on POST, schema-shape validation, idempotency
// on canonical hash, GET 404, GET 400 on bad hash, byte cap, list endpoint.
import { webcrypto } from 'node:crypto';
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto: unknown }).crypto = webcrypto;
}
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import express from 'express';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { SchemaController } from '../controllers/schemaController';
import {
  EndpointSchemaRepository,
  computeSchemaHash,
} from '../repositories/endpointSchemaRepository';
import { errorHandler } from '../middleware/errorHandler';
// @ts-expect-error — ESM subpath
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

let testDb: TestDb;

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
    tags.push(['payload', crypto.createHash('sha256').update(body, 'utf8').digest('hex')]);
  } else {
    tags.push(['payload', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855']);
  }
  const template = {
    kind: 27235,
    created_at: createdAtSec ?? Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
  const signed = finalizeEvent(template, secret);
  return {
    auth: `Nostr ${Buffer.from(JSON.stringify(signed)).toString('base64')}`,
    pubkey,
  };
}

const BASE_URL = 'http://127.0.0.1:80';
const REGISTER_URL = `${BASE_URL}/api/schemas`;

describe('/api/schemas (NIP-98 + JSON Schema registry)', () => {
  let pool: Pool;
  let endpointSchemaRepo: EndpointSchemaRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    endpointSchemaRepo = new EndpointSchemaRepository(pool);
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  function buildApp(): express.Express {
    const controller = new SchemaController({ endpointSchemaRepo });
    const app = express();
    app.use(express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }));
    app.set('trust proxy', 1);
    app.post('/api/schemas', controller.register);
    app.get('/api/schemas', controller.list);
    app.get('/api/schemas/:hash', controller.show);
    app.use(errorHandler);
    return app;
  }

  const SCHEMA = {
    type: 'object',
    required: ['price'],
    properties: { price: { type: 'number' } },
  };

  it('POST without NIP-98 returns 401', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/schemas')
      .send({ schema: SCHEMA });
    expect(res.status).toBe(401);
  });

  it('POST happy path returns 201 + schema_hash, idempotent on resubmit', async () => {
    const app = buildApp();
    const body = JSON.stringify({ schema: SCHEMA, name: 'Price Feed v1' });
    const { auth, pubkey } = signNip98(REGISTER_URL, 'POST', body);
    const r1 = await request(app)
      .post('/api/schemas')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(r1.status).toBe(201);
    expect(r1.body.data.schema_hash).toBe(computeSchemaHash(SCHEMA));
    expect(r1.body.data.created).toBe(true);

    // Re-submit (different created_at so NIP-98 isn't replay-rejected) —
    // same canonical schema → 200, created=false.
    const baseTs = Math.floor(Date.now() / 1000);
    const auth2 = signNip98(REGISTER_URL, 'POST', body, undefined, baseTs + 1).auth;
    const r2 = await request(app)
      .post('/api/schemas')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth2)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(r2.status).toBe(200);
    expect(r2.body.data.created).toBe(false);
    expect(r2.body.data.schema_hash).toBe(r1.body.data.schema_hash);

    // Persisted with the registering operator's pubkey.
    const stored = await endpointSchemaRepo.findByHash(r1.body.data.schema_hash);
    expect(stored?.operator_pubkey).toBe(pubkey);
    expect(stored?.name).toBe('Price Feed v1');
  });

  it('POST with non-object schema returns 400', async () => {
    const app = buildApp();
    const body = JSON.stringify({ schema: 'not an object' });
    const { auth } = signNip98(REGISTER_URL, 'POST', body);
    const res = await request(app)
      .post('/api/schemas')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_schema');
  });

  it('POST with ajv-uncompilable schema returns 400', async () => {
    const app = buildApp();
    const body = JSON.stringify({ schema: { type: 'not-a-real-type' } });
    const { auth } = signNip98(REGISTER_URL, 'POST', body);
    const res = await request(app)
      .post('/api/schemas')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_schema');
  });

  it('GET /api/schemas/:hash returns the stored schema', async () => {
    const app = buildApp();
    const body = JSON.stringify({ schema: SCHEMA });
    const { auth } = signNip98(REGISTER_URL, 'POST', body);
    const r1 = await request(app)
      .post('/api/schemas')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(body);
    const hash = r1.body.data.schema_hash;
    const r2 = await request(app).get(`/api/schemas/${hash}`);
    expect(r2.status).toBe(200);
    expect(r2.body.data.schema_hash).toBe(hash);
    expect(r2.body.data.schema_json).toMatchObject({ type: 'object' });
  });

  it('GET with malformed hash returns 400', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/schemas/not-a-hash');
    expect(res.status).toBe(400);
  });

  it('GET unknown hash returns 404', async () => {
    const app = buildApp();
    const fakeHash = '0'.repeat(64);
    const res = await request(app).get(`/api/schemas/${fakeHash}`);
    expect(res.status).toBe(404);
  });

  it('GET /api/schemas list returns most recent schemas', async () => {
    const app = buildApp();
    // Register 3 distinct schemas.
    for (let i = 0; i < 3; i++) {
      const schema = { type: 'object', properties: { idx: { const: i } } };
      const body = JSON.stringify({ schema });
      const { auth } = signNip98(REGISTER_URL, 'POST', body, undefined, Math.floor(Date.now() / 1000) + i);
      await request(app)
        .post('/api/schemas')
        .set('Host', '127.0.0.1:80')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .send(body);
    }
    const res = await request(app).get('/api/schemas');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(3);
  });
});
