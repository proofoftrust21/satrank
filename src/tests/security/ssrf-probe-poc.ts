// @ts-nocheck — Phase 12C: PoC uses better-sqlite3 Database. TODO Phase 12D:
// port to Postgres ephemeral pool or remove if the assertions are now covered
// by src/tests/security/ssrf-probe.test.ts. Kept for historical reference.
// Phase 11bis — integration assertions for the SSRF hardening applied to
// /api/probe. Post-remediation this script asserts that every known bypass
// shape is blocked with httpError === 'URL_NOT_ALLOWED' (or equivalent for
// the redirect case).
//
// ⚠️ LOCAL ONLY — never run against production. The script spins an
// in-process mock HTTP server on 127.0.0.1:8099 and 127.0.0.1:8100 and
// drives ProbeController.performProbe() directly (no Express, no LND, no
// real DB — :memory: with a stub macaroon).
//
// Run:
//
//   npx tsx src/tests/security/ssrf-probe-poc.ts
//
// Exit 0 on success (all blocks confirmed), 2 on any miss.

import http from 'node:http';
import Database from 'better-sqlite3';
import { ProbeController } from '../../controllers/probeController';
import type { LndGraphClient } from '../../crawler/lndGraphClient';

const MOCK_PORT = 8099;
const REDIRECT_PORT = 8100;
const CANARY_SECRET = 'INTERNAL_CREDENTIAL_NEVER_LEAK_ME';

async function withTwoMockServers<T>(
  mockBody: string,
  redirectTarget: string,
  fn: () => Promise<T>,
): Promise<T> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(mockBody);
  });
  const redirectServer = http.createServer((_req, res) => {
    res.writeHead(302, { Location: redirectTarget });
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(MOCK_PORT, '127.0.0.1', () => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    redirectServer.once('error', reject);
    redirectServer.listen(REDIRECT_PORT, '127.0.0.1', () => resolve());
  });
  try {
    return await fn();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => redirectServer.close(() => resolve()));
  }
}

function mockLnd(): LndGraphClient {
  return {
    canPayInvoices: () => true,
    payInvoice: async () => {
      throw new Error('mockLnd.payInvoice should not run in this test — every scenario is blocked before fetch');
    },
  } as unknown as LndGraphClient;
}

function buildController(): ProbeController {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE token_balance (
      payment_hash BLOB PRIMARY KEY,
      remaining INTEGER,
      balance_credits INTEGER,
      rate_sats_per_request INTEGER
    );
  `);
  return new ProbeController(db, mockLnd());
}

interface Scenario {
  label: string;
  url: string;
  expectBlocked: true;
}

const SCENARIOS: Scenario[] = [
  { label: '1. literal 127.0.0.1',           url: `http://127.0.0.1:${MOCK_PORT}`,                  expectBlocked: true },
  { label: '2. hostname localhost',          url: `http://localhost:${MOCK_PORT}`,                  expectBlocked: true },
  { label: '3. decimal IP 2130706433',       url: `http://2130706433:${MOCK_PORT}`,                 expectBlocked: true },
  { label: '4. userinfo confusion',          url: `http://public.com@127.0.0.1:${MOCK_PORT}`,       expectBlocked: true },
  { label: '5. IMDS 169.254.169.254',        url: `http://169.254.169.254/latest/meta-data/`,       expectBlocked: true },
  { label: '6. redirect 302 → 127.0.0.1',    url: `http://127.0.0.1:${REDIRECT_PORT}/redir`,        expectBlocked: true },
];

/** A scenario is "blocked" if either:
 *   - firstFetch.httpError === 'URL_NOT_ALLOWED' (pre-check or connect-time DNS)
 *   - firstFetch.status ∈ [300, 399] (redirect returned, not followed automatically)
 *  Anything else (status 200, or a stripped connection failure that isn't
 *  URL_NOT_ALLOWED because we actually reached the server) is a MISS. */
function verdictFor(httpError: string | null | undefined, status: number | null | undefined): 'BLOCK' | 'MISS' {
  if (httpError === 'URL_NOT_ALLOWED') return 'BLOCK';
  if (typeof status === 'number' && status >= 300 && status < 400) return 'BLOCK';
  return 'MISS';
}

async function run(scenario: Scenario): Promise<boolean> {
  const controller = buildController();
  const result = await controller.performProbe(scenario.url);
  const verdict = verdictFor(result.firstFetch.httpError, result.firstFetch.status);
  const ok = verdict === 'BLOCK';
  const line = {
    label: scenario.label,
    url: scenario.url,
    verdict,
    firstFetchStatus: result.firstFetch.status,
    httpError: result.firstFetch.httpError ?? null,
  };
  console.log(`  [${ok ? 'OK  ' : 'MISS'}] ${scenario.label.padEnd(32)} status=${String(result.firstFetch.status ?? '-').padStart(3)} httpError=${result.firstFetch.httpError ?? '-'}`);
  if (!ok) {
    console.log('     ↳ unexpected result:', JSON.stringify(line, null, 2));
  }
  return ok;
}

async function main(): Promise<void> {
  console.log('Phase 11bis — post-remediation assertion: SSRF blocked across 6 bypass shapes');
  console.log(`Mock target on 127.0.0.1:${MOCK_PORT} (body "${CANARY_SECRET}"), redirector on 127.0.0.1:${REDIRECT_PORT}\n`);

  let misses = 0;

  await withTwoMockServers(
    JSON.stringify({ secret: CANARY_SECRET }),
    `http://127.0.0.1:${MOCK_PORT}/sensitive`,
    async () => {
      for (const s of SCENARIOS) {
        const ok = await run(s);
        if (!ok) misses++;
      }
    },
  );

  if (misses > 0) {
    console.log(`\n${misses} scenario(s) NOT blocked. SSRF hardening regression — fix before merge.`);
    process.exit(2);
  }
  console.log('\nAll 6 scenarios blocked (URL_NOT_ALLOWED or 3xx unfollowed).');
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('Assertion script failure:', msg);
  process.exit(1);
});
