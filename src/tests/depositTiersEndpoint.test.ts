// Phase 9 C5 — GET /api/deposit/tiers public endpoint tests.
// Goal: confirm the tier schedule is surfaced as the canonical source of
// truth for pricing (no auth, no rate limit, deterministic shape).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { runMigrations } from '../database/migrations';
import { DepositController } from '../controllers/depositController';
import { createV2Routes } from '../routes/v2';
import { errorHandler } from '../middleware/errorHandler';
import { requestIdMiddleware } from '../middleware/requestId';

function buildApp(): { app: express.Express; db: Database.Database } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const depositController = new DepositController(db);
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);

  // We only mount the v2 router fragment that matters for this endpoint.
  // v2Controller is passed as an any-shaped stub because listTiers doesn't
  // route through it — the route wiring lives on depositController.
  const stubV2 = {
    report: (_r: express.Request, res: express.Response) => res.sendStatus(204),
    profile: (_r: express.Request, res: express.Response) => res.sendStatus(204),
  } as unknown as import('../controllers/v2Controller').V2Controller;

  app.use('/api', createV2Routes(stubV2, undefined, undefined, depositController));
  app.use(errorHandler);

  return { app, db };
}

describe('GET /api/deposit/tiers', () => {
  let app: express.Express;
  let db: Database.Database;

  beforeEach(() => {
    const ctx = buildApp();
    app = ctx.app;
    db = ctx.db;
  });

  afterEach(() => db.close());

  it('returns 200 with 5 tiers ordered ascending by minDepositSats', async () => {
    const res = await request(app).get('/api/deposit/tiers');
    expect(res.status).toBe(200);
    expect(res.body.data.tiers).toHaveLength(5);
    expect(res.body.data.tiers.map((t: { minDepositSats: number }) => t.minDepositSats))
      .toEqual([21, 1000, 10000, 100000, 1000000]);
  });

  it('exposes rateSatsPerRequest and discountPct matching the engraved schedule', async () => {
    const res = await request(app).get('/api/deposit/tiers');
    const tiers = res.body.data.tiers as Array<{ rateSatsPerRequest: number; discountPct: number }>;
    expect(tiers.map(t => t.rateSatsPerRequest)).toEqual([1.0, 0.5, 0.2, 0.1, 0.05]);
    expect(tiers.map(t => t.discountPct)).toEqual([0, 50, 80, 90, 95]);
  });

  it('computes requestsPerDeposit (floor/rate) for each tier', async () => {
    const res = await request(app).get('/api/deposit/tiers');
    const tiers = res.body.data.tiers as Array<{ minDepositSats: number; rateSatsPerRequest: number; requestsPerDeposit: number }>;
    // tier 1: 21 / 1.0 = 21
    // tier 2: 1000 / 0.5 = 2000
    // tier 3: 10000 / 0.2 = 50000
    // tier 4: 100000 / 0.1 = 1_000_000
    // tier 5: 1000000 / 0.05 = 20_000_000
    expect(tiers.map(t => t.requestsPerDeposit)).toEqual([21, 2000, 50000, 1_000_000, 20_000_000]);
  });

  it('is public — does NOT require an Authorization header', async () => {
    // No Authorization, no X-API-Key — should still get 200.
    const res = await request(app).get('/api/deposit/tiers');
    expect(res.status).toBe(200);
  });

  it('declares the rate engraving invariant in the response notes', async () => {
    const res = await request(app).get('/api/deposit/tiers');
    const notes = res.body.data.notes as string[];
    expect(notes.some(n => /engraved/i.test(n))).toBe(true);
    expect(notes.some(n => /NO_APPLICABLE_TIER|21 sats/i.test(n))).toBe(true);
  });

  it('uses tierId 1..5 (1-indexed)', async () => {
    const res = await request(app).get('/api/deposit/tiers');
    const ids = (res.body.data.tiers as Array<{ tierId: number }>).map(t => t.tierId);
    expect(ids).toEqual([1, 2, 3, 4, 5]);
  });

  it('response includes currency and rateUnit metadata', async () => {
    const res = await request(app).get('/api/deposit/tiers');
    expect(res.body.data.currency).toBe('sats');
    expect(res.body.data.rateUnit).toBe('sats per request');
  });
});
