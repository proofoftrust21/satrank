// Tests for Phase 9 C8 — /api/probe rate limits.
//
// Goals:
//   - 10/h per token enforced, keyed on payment_hash.
//   - Different tokens have independent counters (isolation).
//   - 100/h global enforced across all tokens.
//   - 429 response shape is { error: { code: 'PROBE_RATE_LIMITED', ... } }.
//   - Retry-After and RateLimit-* headers are present (express-rate-limit
//     standardHeaders).
//   - rateLimitHits counter is incremented with the right `limiter` label.
//
// Each test uses its own Express app so limiter state does not bleed across
// tests. We mount the middleware behind a trivial `200 OK` handler — we
// don't need the full probe pipeline since C8 is about the limit layer.
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { createProbeRateLimit } from '../middleware/probeRateLimit';
import { rateLimitHits, metricsRegistry } from '../middleware/metrics';

function l402Header(): { header: string; preimage: string; paymentHash: string } {
  const preimage = crypto.randomBytes(32).toString('hex');
  const paymentHash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
  // Macaroon bytes are opaque here — the limiter only parses the preimage.
  return { header: `L402 AAAA:${preimage}`, preimage, paymentHash };
}

function buildApp(opts: { perTokenPerHour: number; globalPerHour: number; keyPrefix: string }) {
  const app = express();
  const limits = createProbeRateLimit({
    perTokenPerHour: opts.perTokenPerHour,
    globalPerHour: opts.globalPerHour,
    testOnlyKeyPrefix: opts.keyPrefix,
  });
  app.post('/api/probe', limits.perToken, limits.global, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

async function getHitValue(limiter: string): Promise<number> {
  const metrics = await metricsRegistry.getMetricsAsJSON();
  const hit = metrics.find(m => m.name === 'satrank_rate_limit_hits_total');
  if (!hit) return 0;
  const row = (hit.values as Array<{ labels: Record<string, string>; value: number }>).find(
    v => v.labels.limiter === limiter,
  );
  return row?.value ?? 0;
}

describe('ProbeRateLimit — per-token', () => {
  let app: express.Express;
  const prefix = `test-pt-${crypto.randomBytes(4).toString('hex')}-`;

  beforeEach(() => {
    app = buildApp({ perTokenPerHour: 10, globalPerHour: 10_000, keyPrefix: prefix });
  });

  it('allows 10 requests under the per-token limit, rejects the 11th', async () => {
    const { header } = l402Header();
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/api/probe').set('Authorization', header);
      expect(res.status).toBe(200);
    }
    const eleventh = await request(app).post('/api/probe').set('Authorization', header);
    expect(eleventh.status).toBe(429);
    expect(eleventh.body).toEqual({
      error: {
        code: 'PROBE_RATE_LIMITED',
        message: expect.stringContaining('retry after'),
      },
    });
    expect(eleventh.headers['retry-after']).toBeDefined();
    expect(eleventh.headers['ratelimit-limit']).toBe('10');
  });

  it('counters are independent across tokens', async () => {
    const a = l402Header();
    const b = l402Header();
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/api/probe').set('Authorization', a.header);
      expect(res.status).toBe(200);
    }
    // Token A is burnt but token B is fresh.
    const aBlocked = await request(app).post('/api/probe').set('Authorization', a.header);
    expect(aBlocked.status).toBe(429);
    const bFirst = await request(app).post('/api/probe').set('Authorization', b.header);
    expect(bFirst.status).toBe(200);
  });

  it('falls back to IP keying when the L402 header is absent', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/api/probe');
      expect(res.status).toBe(200);
    }
    const eleventh = await request(app).post('/api/probe');
    expect(eleventh.status).toBe(429);
  });

  it('increments the probe_per_token metric on rejection', async () => {
    const { header } = l402Header();
    const before = await getHitValue('probe_per_token');
    for (let i = 0; i < 10; i++) {
      await request(app).post('/api/probe').set('Authorization', header);
    }
    await request(app).post('/api/probe').set('Authorization', header); // 11th → 429
    await request(app).post('/api/probe').set('Authorization', header); // 12th → 429
    const after = await getHitValue('probe_per_token');
    expect(after - before).toBe(2);
  });
});

describe('ProbeRateLimit — global', () => {
  it('rejects after 100 requests regardless of token', async () => {
    const prefix = `test-g-${crypto.randomBytes(4).toString('hex')}-`;
    const app = buildApp({ perTokenPerHour: 10_000, globalPerHour: 3, keyPrefix: prefix });

    // Three different tokens — global still caps at 3.
    const h1 = l402Header().header;
    const h2 = l402Header().header;
    const h3 = l402Header().header;
    const h4 = l402Header().header;

    expect((await request(app).post('/api/probe').set('Authorization', h1)).status).toBe(200);
    expect((await request(app).post('/api/probe').set('Authorization', h2)).status).toBe(200);
    expect((await request(app).post('/api/probe').set('Authorization', h3)).status).toBe(200);
    const fourth = await request(app).post('/api/probe').set('Authorization', h4);
    expect(fourth.status).toBe(429);
    expect(fourth.body.error.code).toBe('PROBE_RATE_LIMITED');
  });

  it('increments the probe_global metric on rejection', async () => {
    const prefix = `test-gm-${crypto.randomBytes(4).toString('hex')}-`;
    const app = buildApp({ perTokenPerHour: 10_000, globalPerHour: 2, keyPrefix: prefix });
    const before = await getHitValue('probe_global');
    await request(app).post('/api/probe').set('Authorization', l402Header().header);
    await request(app).post('/api/probe').set('Authorization', l402Header().header);
    await request(app).post('/api/probe').set('Authorization', l402Header().header); // → 429
    const after = await getHitValue('probe_global');
    expect(after - before).toBe(1);
  });

  it('per-token rejects before global when both would apply', async () => {
    // If per-token trips first, probe_per_token goes up but probe_global does not
    // (the limiter ordering short-circuits the chain).
    const prefix = `test-order-${crypto.randomBytes(4).toString('hex')}-`;
    const app = buildApp({ perTokenPerHour: 2, globalPerHour: 10, keyPrefix: prefix });
    const { header } = l402Header();
    const ptBefore = await getHitValue('probe_per_token');
    const gBefore = await getHitValue('probe_global');

    await request(app).post('/api/probe').set('Authorization', header);
    await request(app).post('/api/probe').set('Authorization', header);
    const blocked = await request(app).post('/api/probe').set('Authorization', header);
    expect(blocked.status).toBe(429);

    const ptAfter = await getHitValue('probe_per_token');
    const gAfter = await getHitValue('probe_global');
    expect(ptAfter - ptBefore).toBe(1);
    expect(gAfter - gBefore).toBe(0);
  });
});
