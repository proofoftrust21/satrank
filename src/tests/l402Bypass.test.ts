// Phase 12A A3 — L402_BYPASS double-gate fail-safe + middleware short-circuit.
// Goal: prove that the combo NODE_ENV=production + L402_BYPASS=true cannot
// boot the process (config refuses, exit != 0), and that the bypass branch
// of createBalanceAuth calls next() without touching the DB.
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import express from 'express';
import { createBalanceAuth } from '../middleware/balanceAuth';
let testDb: TestDb;

const CONFIG_MODULE = path.resolve(__dirname, '../config.ts');

function bootConfig(env: Record<string, string | undefined>): { code: number | null; stderr: string; stdout: string } {
  // Spawn a child node process that imports the config module and exits.
  // The config module runs its validation at import-time; a successful
  // parse -> clean exit 0; a refused combo -> process.exit(1) from within.
  //
  // Inherit the FULL parent env and layer our overrides on top. If we
  // passed only a whitelist, dotenv.config() inside the child ends up
  // reading the repo's .env which pins NODE_ENV=development (which would
  // then conflict with our NODE_ENV=production overrides through the
  // "dev + secrets" guard in config.ts lines 177-186).
  //
  // env values of `undefined` are removed (zod treats an empty-string
  // API_KEY as "invalid" which would mask the L402_BYPASS guard we want
  // to exercise; we need the key fully absent, not empty).
  const merged: Record<string, string | undefined> = {
    ...process.env,
    // Baseline required when NODE_ENV=production so only the L402_BYPASS
    // guard can fail the boot (not the API_KEY or SERVER_IP guards).
    API_KEY: 'ci-test-api-key-not-a-placeholder',
    APERTURE_SHARED_SECRET: 'ci-test-aperture-shared-secret',
    SERVER_IP: '203.0.113.1',
    CORS_ORIGIN: 'https://example.test',
    // Drop any L402_BYPASS inherited from the parent so the test owns it
    L402_BYPASS: undefined,
    ...env,
  };
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined && v !== '') childEnv[k] = v;
  }
  const result = spawnSync(
    'npx',
    ['-y', 'tsx', CONFIG_MODULE],
    { env: childEnv, encoding: 'utf8', timeout: 20_000 },
  );
  return { code: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
}

describe('L402_BYPASS double-gate (config fail-safe)', () => {
  it('REFUSES to boot when NODE_ENV=production + L402_BYPASS=true', async () => {
    const { code, stderr } = bootConfig({ NODE_ENV: 'production', L402_BYPASS: 'true' });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/REFUSED.*L402_BYPASS.*NODE_ENV=production/s);
  }, 30_000);

  it('BOOTS in development with L402_BYPASS=true (staging/bench mode)', async () => {
    const { code, stderr } = bootConfig({
      NODE_ENV: 'development',
      L402_BYPASS: 'true',
      // Must strip production secrets or the "dev + secrets" guard (lines
      // 177-186 of config.ts) would eat the test; undefined removes them.
      API_KEY: undefined,
      APERTURE_SHARED_SECRET: undefined,
    });
    expect(code, `stderr:\n${stderr}`).toBe(0);
    expect(stderr).not.toMatch(/REFUSED/);
  }, 30_000);

  it('BOOTS in production when L402_BYPASS is unset (legacy/default path)', async () => {
    const { code, stderr } = bootConfig({ NODE_ENV: 'production' });
    expect(code, `stderr:\n${stderr}`).toBe(0);
  }, 30_000);

  it('BOOTS in production when L402_BYPASS=false (explicit disable)', async () => {
    const { code, stderr } = bootConfig({ NODE_ENV: 'production', L402_BYPASS: 'false' });
    expect(code, `stderr:\n${stderr}`).toBe(0);
  }, 30_000);
});

describe('createBalanceAuth bypass branch', async () => {
  it('short-circuits to next() without touching the DB when bypass=true', async () => {
    const testDb = await setupTestPool();
    const db = testDb.pool;
    const byPass = createBalanceAuth(db, { bypass: true });

    // Real L402 header that would normally hit a DB decrement path —
    // under bypass=true the middleware must NOT read/write token_balance.
    const auth = 'L402 Zm9v:' + 'a'.repeat(64);
    const req = { headers: { authorization: auth } } as express.Request;
    const emitter = new EventEmitter();
    const headersSet: Record<string, string> = {};
    const res = Object.assign(emitter, {
      setHeader: (k: string, v: string) => { headersSet[k] = v; },
      status: () => ({ json: () => { throw new Error('bypass must call next(), not status().json()'); } }),
    }) as unknown as express.Response;

    const called = await new Promise<boolean>((resolve) => {
      byPass(req, res, ((err?: unknown) => {
        if (err) throw err as Error;
        resolve(true);
      }) as express.NextFunction);
    });

    expect(called).toBe(true);
    // No DB row created for the synthetic payment_hash
    const { rows: countRows } = await db.query<{ c: string }>('SELECT COUNT(*) AS c FROM token_balance');
    expect(Number(countRows[0].c)).toBe(0);
    // No balance header emitted (the bypass is transparent, not 21/21)
    expect(headersSet['X-SatRank-Balance']).toBeUndefined();
    await teardownTestPool(testDb);
  });
});
