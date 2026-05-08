// SatRank V3 — smoke tests.
//
// Pure-function tests only. No DB, no network. The integration suite is
// the docker-compose stack itself : if `docker-compose up` boots cleanly
// and `curl /api/health` returns ok, the system is live.

import { describe, it, expect } from 'vitest';
import { STAGES, type Stage } from '../types.js';

describe('STAGES', () => {
  it('has exactly 5 stages in order', () => {
    expect(STAGES).toEqual(['challenge', 'invoice', 'payment', 'delivery', 'quality']);
  });

  it('each stage is a string literal', () => {
    for (const s of STAGES) {
      const _checkStage: Stage = s; // compile-time check
      expect(typeof s).toBe('string');
      void _checkStage;
    }
  });
});

describe('config', () => {
  it('parses with sane defaults when DATABASE_URL is set', async () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://localhost/test';
    try {
      // Re-import to trigger re-parse — vitest caches the module so this is
      // best-effort. The smoke point: no crash on minimal env.
      const { config } = await import('../config.js');
      expect(config.PORT).toBeGreaterThan(0);
      expect(config.MEANINGFUL_N_OBS_MIN).toBeGreaterThanOrEqual(1);
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });
});
