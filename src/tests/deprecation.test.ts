// Phase 5 — tests déprécation /api/decide + /api/best-route.
// Vérifie :
//   - header Deprecation: true
//   - header Link: <successor>; rel="successor-version"
//   - body.meta.deprecated_use: "/api/intent"
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { markDeprecated, patchDeprecatedBody } from '../utils/deprecation';

describe('deprecation helpers', () => {
  it('markDeprecated set les headers Deprecation + Link', async () => {
    const app = express();
    app.get('/legacy', (_req, res) => {
      markDeprecated(res, '/api/intent');
      res.json({ ok: true });
    });
    const r = await request(app).get('/legacy');
    expect(r.status).toBe(200);
    expect(r.headers['deprecation']).toBe('true');
    expect(r.headers['link']).toBe('</api/intent>; rel="successor-version"');
  });

  it('patchDeprecatedBody injecte meta.deprecated_use sans écraser meta existant', () => {
    const body = { data: { x: 1 }, meta: { total: 5 } };
    const patched = patchDeprecatedBody(body, '/api/intent');
    expect(patched.data).toEqual({ x: 1 });
    expect(patched.meta).toEqual({ total: 5, deprecated_use: '/api/intent' });
  });

  it('patchDeprecatedBody crée meta si absent', () => {
    const body = { data: { x: 1 } };
    const patched = patchDeprecatedBody(body, '/api/intent') as unknown as { meta: { deprecated_use: string } };
    expect(patched.meta.deprecated_use).toBe('/api/intent');
  });

  it('patchDeprecatedBody ne mute pas le body original', () => {
    const body = { data: { x: 1 } };
    patchDeprecatedBody(body, '/api/intent');
    expect(body).toEqual({ data: { x: 1 } });
    expect('meta' in body).toBe(false);
  });
});
