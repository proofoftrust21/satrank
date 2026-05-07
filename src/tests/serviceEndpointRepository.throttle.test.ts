// Phase 11D — fulfill-aware probe throttle.
//
// When an endpoint has accumulated ≥N successful fulfill_jobs in the last
// M days, the paid-probe candidate selection skips it: the post-pay signal
// from /api/fulfill is denser and more truthful than a synthetic paid probe,
// so the budget redirects to the cold-start long tail instead. This test
// exercises both findPaidProbeCandidates and findSweepCandidates with the
// same fixture set.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';

let testDb: TestDb;
let pool: Pool;
let repo: ServiceEndpointRepository;

const URL_FULFILL_HEAVY = 'https://api.example.com/heavy';
const URL_FULFILL_LIGHT = 'https://api.example.com/light';
const URL_NEVER_FULFILLED = 'https://api.example.com/cold';

async function seedEndpoint(url: string, opts: { hasIntent: boolean }): Promise<void> {
  // Match the prod hot/sweep filter contract: deprecated=false, check_count>=1,
  // last_http_status=402 (so the audit-r3 filter accepts the row), and
  // last_intent_query_at populated for the hot tier.
  const now = Math.floor(Date.now() / 1000);
  await pool.query(
    `INSERT INTO service_endpoints
       (agent_hash, url, last_http_status, last_latency_ms, last_checked_at,
        check_count, success_count, created_at, source, sources,
        last_intent_query_at, service_price_sats, deprecated)
     VALUES (NULL, $1, 402, 100, $2, 5, 5, $2, '402index', ARRAY['402index']::text[],
             $3, 5, FALSE)`,
    [url, now, opts.hasIntent ? now : null],
  );
}

async function seedSuccessfulFulfill(
  jobId: string,
  candidateUrl: string,
  opts: { createdAtSecAgo: number; n_attempts: number },
): Promise<void> {
  const created = Math.floor(Date.now() / 1000) - opts.createdAtSecAgo;
  // Build n_attempts entries, each marked delivery_ok against the same URL.
  // Real prod jobs only retain 1-3 attempts per job; we may seed several
  // jobs per endpoint OR one job with multiple attempts — the SQL counts
  // attempts via jsonb_array_elements so both seedings produce identical
  // success_count.
  const attempts = Array.from({ length: opts.n_attempts }, (_, i) => ({
    candidate_url: candidateUrl,
    rank: i + 1,
    ts_started: created,
    ts_finished: created + 1,
    payment_outcome: 'pay_ok',
    delivery_outcome: 'delivery_ok',
    http_status: 200,
    sats_paid: 1,
  }));
  await pool.query(
    `INSERT INTO fulfill_jobs
       (job_id, agent_pubkey, intent_hash, max_sats, max_latency_ms,
        status, attempts, sats_spent, sats_refunded, premium_sats,
        preimage, result_body_sha256, reason, created_at, settled_at,
        mode)
     VALUES ($1, 'agent_pk_test', 'intent_hash_test', 100, 5000,
             'success', $2::jsonb, 1, 0, 0,
             'preimage_test', 'sha_test', NULL, $3, $3,
             'deposit')`,
    [jobId, JSON.stringify(attempts), created],
  );
}

beforeAll(async () => {
  testDb = await setupTestPool();
  pool = testDb.pool;
  repo = new ServiceEndpointRepository(pool);
});

afterAll(async () => {
  await teardownTestPool(testDb);
});

beforeEach(async () => {
  await pool.query('TRUNCATE service_endpoints, fulfill_jobs RESTART IDENTITY CASCADE');
});

describe('Phase 11D — fulfill-aware probe throttle', () => {
  describe('findPaidProbeCandidates', () => {
    it('skipIfRecentFulfillsAtLeast=0 returns endpoints regardless of fulfill activity', async () => {
      await seedEndpoint(URL_FULFILL_HEAVY, { hasIntent: true });
      await seedEndpoint(URL_NEVER_FULFILLED, { hasIntent: true });
      // 5 successful attempts in the last 24h on URL_FULFILL_HEAVY.
      await seedSuccessfulFulfill('job_h', URL_FULFILL_HEAVY, {
        createdAtSecAgo: 3600,
        n_attempts: 5,
      });

      const rows = await repo.findPaidProbeCandidates({
        limit: 10,
        maxPriceSats: 50,
        skipIfRecentFulfillsAtLeast: 0,
      });
      const urls = rows.map((r) => r.url).sort();
      expect(urls).toEqual([URL_FULFILL_HEAVY, URL_NEVER_FULFILLED].sort());
    });

    it('skipIfRecentFulfillsAtLeast=3 excludes endpoints with ≥3 successful fulfills', async () => {
      await seedEndpoint(URL_FULFILL_HEAVY, { hasIntent: true });
      await seedEndpoint(URL_FULFILL_LIGHT, { hasIntent: true });
      await seedEndpoint(URL_NEVER_FULFILLED, { hasIntent: true });
      // HEAVY: 5 attempts → throttled.
      await seedSuccessfulFulfill('job_h', URL_FULFILL_HEAVY, {
        createdAtSecAgo: 3600,
        n_attempts: 5,
      });
      // LIGHT: 2 attempts → below threshold, not throttled.
      await seedSuccessfulFulfill('job_l', URL_FULFILL_LIGHT, {
        createdAtSecAgo: 3600,
        n_attempts: 2,
      });

      const rows = await repo.findPaidProbeCandidates({
        limit: 10,
        maxPriceSats: 50,
        skipIfRecentFulfillsAtLeast: 3,
      });
      const urls = rows.map((r) => r.url).sort();
      expect(urls).toEqual([URL_FULFILL_LIGHT, URL_NEVER_FULFILLED].sort());
    });

    it('throttle ignores fulfills outside the window', async () => {
      await seedEndpoint(URL_FULFILL_HEAVY, { hasIntent: true });
      // 10 attempts but 60 days ago → outside the default 30-day window.
      await seedSuccessfulFulfill('job_old', URL_FULFILL_HEAVY, {
        createdAtSecAgo: 60 * 86400,
        n_attempts: 10,
      });

      const rows = await repo.findPaidProbeCandidates({
        limit: 10,
        maxPriceSats: 50,
        skipIfRecentFulfillsAtLeast: 3,
        recentFulfillsWindowDays: 30,
      });
      expect(rows.map((r) => r.url)).toEqual([URL_FULFILL_HEAVY]);
    });

    it('throttle ignores non-success fulfill_jobs', async () => {
      await seedEndpoint(URL_FULFILL_HEAVY, { hasIntent: true });
      // Insert a refunded job with 5 delivery_ok attempts — should NOT count
      // (the job overall failed, those attempts may have succeeded
      // individually but the job rolled back).
      const created = Math.floor(Date.now() / 1000) - 3600;
      const attempts = Array.from({ length: 5 }, (_, i) => ({
        candidate_url: URL_FULFILL_HEAVY,
        rank: i + 1,
        ts_started: created,
        ts_finished: created + 1,
        payment_outcome: 'pay_ok',
        delivery_outcome: 'delivery_ok',
        http_status: 200,
        sats_paid: 1,
      }));
      await pool.query(
        `INSERT INTO fulfill_jobs
           (job_id, agent_pubkey, intent_hash, max_sats, max_latency_ms,
            status, attempts, sats_spent, sats_refunded, premium_sats,
            preimage, result_body_sha256, reason, created_at, settled_at,
            mode)
         VALUES ('job_refunded', 'a', 'i', 100, 5000,
                 'refunded', $1::jsonb, 0, 5, 0,
                 NULL, NULL, NULL, $2, $2,
                 'deposit')`,
        [JSON.stringify(attempts), created],
      );

      const rows = await repo.findPaidProbeCandidates({
        limit: 10,
        maxPriceSats: 50,
        skipIfRecentFulfillsAtLeast: 3,
      });
      expect(rows.map((r) => r.url)).toEqual([URL_FULFILL_HEAVY]);
    });

    it('throttle ignores attempts whose delivery_outcome is not delivery_ok', async () => {
      await seedEndpoint(URL_FULFILL_HEAVY, { hasIntent: true });
      // 5 attempts on a successful job, but each marked delivery_4xx.
      const created = Math.floor(Date.now() / 1000) - 3600;
      const attempts = Array.from({ length: 5 }, (_, i) => ({
        candidate_url: URL_FULFILL_HEAVY,
        rank: i + 1,
        ts_started: created,
        ts_finished: created + 1,
        payment_outcome: 'pay_ok',
        delivery_outcome: 'delivery_4xx',
        http_status: 400,
        sats_paid: 1,
      }));
      await pool.query(
        `INSERT INTO fulfill_jobs
           (job_id, agent_pubkey, intent_hash, max_sats, max_latency_ms,
            status, attempts, sats_spent, sats_refunded, premium_sats,
            preimage, result_body_sha256, reason, created_at, settled_at,
            mode)
         VALUES ('job_bad_delivery', 'a', 'i', 100, 5000,
                 'success', $1::jsonb, 5, 0, 0,
                 'pre_test', 'sha_test', NULL, $2, $2,
                 'deposit')`,
        [JSON.stringify(attempts), created],
      );

      const rows = await repo.findPaidProbeCandidates({
        limit: 10,
        maxPriceSats: 50,
        skipIfRecentFulfillsAtLeast: 3,
      });
      // Endpoint NOT throttled — delivery_outcome did not match.
      expect(rows.map((r) => r.url)).toEqual([URL_FULFILL_HEAVY]);
    });
  });

  describe('findSweepCandidates', () => {
    it('skipIfRecentFulfillsAtLeast=3 excludes endpoints with ≥3 successful fulfills', async () => {
      // Sweep does NOT require last_intent_query_at to be set.
      await seedEndpoint(URL_FULFILL_HEAVY, { hasIntent: false });
      await seedEndpoint(URL_NEVER_FULFILLED, { hasIntent: false });
      await seedSuccessfulFulfill('job_h', URL_FULFILL_HEAVY, {
        createdAtSecAgo: 3600,
        n_attempts: 4,
      });

      const rows = await repo.findSweepCandidates({
        limit: 10,
        maxPriceSats: 50,
        skipIfRecentFulfillsAtLeast: 3,
      });
      expect(rows.map((r) => r.url)).toEqual([URL_NEVER_FULFILLED]);
    });

    it('skipIfRecentFulfillsAtLeast=0 disables the throttle on the sweep path too', async () => {
      await seedEndpoint(URL_FULFILL_HEAVY, { hasIntent: false });
      await seedSuccessfulFulfill('job_h', URL_FULFILL_HEAVY, {
        createdAtSecAgo: 3600,
        n_attempts: 10,
      });

      const rows = await repo.findSweepCandidates({
        limit: 10,
        maxPriceSats: 50,
        skipIfRecentFulfillsAtLeast: 0,
      });
      expect(rows.map((r) => r.url)).toEqual([URL_FULFILL_HEAVY]);
    });
  });
});
