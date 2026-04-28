// Phase 6.3 — /api/oracle/assertion/:url_hash : retourne le metadata
// kind 30782 pour BOLT12 embedding.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { Application } from 'express';
import type { Pool } from 'pg';
import {
  setupTestPool,
  teardownTestPool,
  truncateAll,
  type TestDb,
} from './helpers/testDatabase';
import { TrustAssertionRepository } from '../repositories/trustAssertionRepository';

let testDb: TestDb;
const NOW_FAKE = 1_700_000_000;

/** Mini Express app avec uniquement la route /api/oracle/assertion. Évite
 *  la complexité du bootstrap complet (createApp dépend de LND, Nostr,
 *  etc.). La route teste exactement la logique copiée de app.ts — si la
 *  divergence devient significative, on ré-importe le handler. */
function buildTestApp(repo: TrustAssertionRepository): Application {
  const app = express();
  app.use(express.json());
  app.get('/api/oracle/assertion/:url_hash', async (req, res, next) => {
    try {
      const urlHash = String(req.params.url_hash);
      if (!/^[a-f0-9]{64}$/.test(urlHash)) {
        return res.status(400).json({ error: { code: 'INVALID_URL_HASH', message: 'url_hash must be a 64-char hex SHA256' } });
      }
      const record = await repo.findByUrlHash(urlHash);
      if (!record) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No trust assertion published yet for this endpoint.' } });
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const expiresInSec = record.valid_until - nowSec;
      res.json({
        data: {
          endpoint_url_hash: record.endpoint_url_hash,
          kind: 30782,
          event_id: record.event_id,
          oracle_pubkey: record.oracle_pubkey,
          valid_until: record.valid_until,
          expires_in_sec: expiresInSec,
          expired: expiresInSec < 0,
          p_e2e: record.p_e2e,
          meaningful_stages_count: record.meaningful_stages_count,
          calibration_proof_event_id: record.calibration_proof_event_id,
          published_at: record.published_at,
          relays: record.relays,
          bolt12_tlv_hint: {
            type_event_id: 65537,
            type_oracle_pubkey: 65538,
            event_id_hex: record.event_id,
            oracle_pubkey_hex: record.oracle_pubkey,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  });
  return app;
}

describe('/api/oracle/assertion/:url_hash (Phase 6.3)', () => {
  let pool: Pool;
  let trustRepo: TrustAssertionRepository;
  let app: Application;

  beforeEach(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    trustRepo = new TrustAssertionRepository(pool);
    await truncateAll(pool);
    app = buildTestApp(trustRepo);
  });

  afterEach(async () => {
    await teardownTestPool(testDb);
  });

  it('returns 400 for non-hex url_hash', async () => {
    const res = await request(app).get('/api/oracle/assertion/not-a-hash');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_URL_HASH');
  });

  it('returns 404 when no assertion published yet for this endpoint', async () => {
    const urlHash = 'a'.repeat(64);
    const res = await request(app).get(`/api/oracle/assertion/${urlHash}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns the metadata + bolt12_tlv_hint when an assertion exists', async () => {
    const urlHash = 'b'.repeat(64);
    await trustRepo.upsert({
      endpoint_url_hash: urlHash,
      event_id: 'e'.repeat(64),
      oracle_pubkey: 'o'.repeat(64),
      valid_until: NOW_FAKE + 7 * 86400,
      p_e2e: 0.85,
      meaningful_stages_count: 2,
      calibration_proof_event_id: 'c'.repeat(64),
      published_at: NOW_FAKE,
      relays: ['wss://relay.damus.io', 'wss://nos.lol'],
    });

    const res = await request(app).get(`/api/oracle/assertion/${urlHash}`);
    expect(res.status).toBe(200);
    expect(res.body.data.kind).toBe(30782);
    expect(res.body.data.event_id).toBe('e'.repeat(64));
    expect(res.body.data.oracle_pubkey).toBe('o'.repeat(64));
    expect(res.body.data.p_e2e).toBe(0.85);
    expect(res.body.data.meaningful_stages_count).toBe(2);
    expect(res.body.data.calibration_proof_event_id).toBe('c'.repeat(64));
    expect(res.body.data.relays).toEqual(['wss://relay.damus.io', 'wss://nos.lol']);
    expect(res.body.data.bolt12_tlv_hint.type_event_id).toBe(65537);
    expect(res.body.data.bolt12_tlv_hint.type_oracle_pubkey).toBe(65538);
    expect(res.body.data.bolt12_tlv_hint.event_id_hex).toBe('e'.repeat(64));
  });

  it('flags expired=true when valid_until < now', async () => {
    const urlHash = 'd'.repeat(64);
    const longAgo = Math.floor(Date.now() / 1000) - 3600 * 24 * 30;
    await trustRepo.upsert({
      endpoint_url_hash: urlHash,
      event_id: 'e'.repeat(64),
      oracle_pubkey: 'o'.repeat(64),
      valid_until: longAgo + 86400, // expired 29 days ago
      p_e2e: 0.5,
      meaningful_stages_count: 1,
      calibration_proof_event_id: null,
      published_at: longAgo,
      relays: ['wss://relay.damus.io'],
    });
    const res = await request(app).get(`/api/oracle/assertion/${urlHash}`);
    expect(res.status).toBe(200);
    expect(res.body.data.expired).toBe(true);
    expect(res.body.data.expires_in_sec).toBeLessThan(0);
  });
});
