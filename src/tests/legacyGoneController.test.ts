// Phase 10 C9 — observability contract for the 410 Gone legacy handler.
//
// The handler in src/controllers/legacyGoneController.ts wires two
// observability paths that we want to lock down with tests so a future
// refactor cannot silently drop them:
//   1. Prometheus counter `satrank_legacy_endpoint_calls_total{endpoint=...}`
//      increments on every call — operators use this to decide when the
//      410 handler itself is safe to retire.
//   2. A structured pino `info` log is emitted with `route`, `successor`,
//      `removed_on`, `ip`, `user_agent`, `request_id` — required for
//      IP/UA forensics when a caller is still stuck on the old path.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createGoneHandler } from '../controllers/legacyGoneController';
import { legacyEndpointCallsTotal } from '../middleware/metrics';
import { logger } from '../logger';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { requestId?: string }).requestId = 'req-test-abc';
    next();
  });
  app.post('/api/decide', createGoneHandler({
    from: '/api/decide',
    to: '/api/intent',
    removedOn: '2026-04-20',
    docs: 'https://satrank.dev/docs/migration-to-1.0',
  }));
  app.post('/api/best-route', createGoneHandler({
    from: '/api/best-route',
    to: '/api/intent',
    removedOn: '2026-04-20',
    docs: 'https://satrank.dev/docs/migration-to-1.0',
  }));
  return app;
}

async function counterValue(endpoint: string): Promise<number> {
  const snapshot = await legacyEndpointCallsTotal.get();
  const match = snapshot.values.find(v => v.labels.endpoint === endpoint);
  return match?.value ?? 0;
}

describe('legacyGoneController — observability contract (Phase 10 C9)', () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp();
    vi.restoreAllMocks();
  });

  it('increments satrank_legacy_endpoint_calls_total on /api/decide hit', async () => {
    const before = await counterValue('/api/decide');
    await request(app).post('/api/decide').send({}).expect(410);
    const after = await counterValue('/api/decide');
    expect(after).toBe(before + 1);
  });

  it('increments satrank_legacy_endpoint_calls_total on /api/best-route hit', async () => {
    const before = await counterValue('/api/best-route');
    await request(app).post('/api/best-route').send({}).expect(410);
    const after = await counterValue('/api/best-route');
    expect(after).toBe(before + 1);
  });

  it('increments per-endpoint labels independently', async () => {
    const decideBefore = await counterValue('/api/decide');
    const bestRouteBefore = await counterValue('/api/best-route');
    await request(app).post('/api/decide').send({}).expect(410);
    await request(app).post('/api/decide').send({}).expect(410);
    await request(app).post('/api/best-route').send({}).expect(410);
    expect(await counterValue('/api/decide')).toBe(decideBefore + 2);
    expect(await counterValue('/api/best-route')).toBe(bestRouteBefore + 1);
  });

  it('emits a structured pino info log with route + successor + forensics fields', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    await request(app)
      .post('/api/decide')
      .set('User-Agent', 'test-agent/1.0')
      .send({})
      .expect(410);

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [payload, message] = infoSpy.mock.calls[0];
    expect(message).toBe('legacy endpoint called');
    expect(payload).toMatchObject({
      route: '/api/decide',
      successor: '/api/intent',
      removed_on: '2026-04-20',
      user_agent: 'test-agent/1.0',
      request_id: 'req-test-abc',
    });
    expect(payload).toHaveProperty('ip');
  });

  it('log payload falls back to null when user-agent / request-id are absent', async () => {
    const bareApp = express();
    bareApp.use(express.json());
    bareApp.post('/api/decide', createGoneHandler({
      from: '/api/decide',
      to: '/api/intent',
      removedOn: '2026-04-20',
      docs: 'https://satrank.dev/docs/migration-to-1.0',
    }));
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    await request(bareApp)
      .post('/api/decide')
      .unset('User-Agent')
      .send({})
      .expect(410);

    const [payload] = infoSpy.mock.calls[0];
    expect(payload).toMatchObject({
      route: '/api/decide',
      user_agent: null,
      request_id: null,
    });
  });
});
