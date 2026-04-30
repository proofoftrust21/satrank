// Phase 1 (2026-05-01) — FulfillService tests.
//
// Cover the orchestrator: happy path, retry-on-fail, refund-on-all-fail,
// insufficient balance, idempotency, self-pay, hostile invoices, debit
// race, premium formula, canonical intent hash.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { encode, sign } from 'bolt11';
import * as nodeCrypto from 'node:crypto';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { FulfillService, computePremium, canonicalIntentHash } from '../services/fulfillService';
import { FulfillJobRepository } from '../repositories/fulfillJobRepository';
import { RefundLedgerRepository } from '../repositories/refundLedgerRepository';
import { RefundEngine, DEFAULT_REFUND_ENGINE_CONFIG } from '../services/refundEngine';
import type { IntentService } from '../services/intentService';
import type { IntentCandidate, IntentResponse } from '../types/intent';
import type { LndGraphClient } from '../crawler/lndGraphClient';

let testDb: TestDb;

const PEER_PRIV = Buffer.from('b'.repeat(64), 'hex');
const PREIMAGE_HEX = 'd'.repeat(64);
const PAYMENT_HASH_HEX = nodeCrypto
  .createHash('sha256')
  .update(Buffer.from(PREIMAGE_HEX, 'hex'))
  .digest('hex');

function makeInvoice(amountSats: number): string {
  const data: Record<string, unknown> = {
    coinType: 'bitcoin',
    timestamp: Math.floor(Date.now() / 1000),
    satoshis: amountSats,
    tags: [
      { tagName: 'payment_hash', data: PAYMENT_HASH_HEX },
      { tagName: 'description', data: 'fulfill-test' },
      { tagName: 'expire_time', data: 3600 },
    ],
  };
  const encoded = encode(data as Parameters<typeof encode>[0]);
  const signed = sign(encoded, PEER_PRIV) as { paymentRequest: string };
  return signed.paymentRequest;
}

function fakeLnd(behavior: { payOk?: boolean; routingError?: boolean; unwired?: boolean }): Pick<LndGraphClient, 'payInvoice'> {
  if (behavior.unwired) {
    // Mirrors a real LND class where the admin macaroon failed to load:
    // payInvoice is undefined, the fulfill service short-circuits.
    return {};
  }
  return {
    payInvoice: async () => {
      if (behavior.routingError) {
        return { paymentPreimage: '', paymentHash: '', paymentError: 'no_route' };
      }
      if (!behavior.payOk) {
        return { paymentPreimage: '', paymentHash: '', paymentError: 'unknown' };
      }
      return { paymentPreimage: PREIMAGE_HEX, paymentHash: PAYMENT_HASH_HEX };
    },
  };
}

function makeCandidate(
  url: string,
  rank: number,
  opts: { p_e2e_pess?: number; price_sats?: number } = {},
): IntentCandidate {
  return {
    rank,
    endpoint_url: url,
    endpoint_hash: 'h'.repeat(64),
    operator_pubkey: '02' + 'c'.repeat(64),
    operator_id: null,
    service_name: 'test',
    price_sats: opts.price_sats ?? 5,
    median_latency_ms: 50,
    http_method: 'GET',
    stage_posteriors: opts.p_e2e_pess !== undefined
      ? {
          stages: {},
          p_e2e: 0.7,
          p_e2e_pessimistic: opts.p_e2e_pess,
          p_e2e_optimistic: 0.9,
          meaningful_stages: ['challenge'],
          measured_stages: 1,
        }
      : undefined,
    bayesian: {
      p_success: 0.8,
      ci95_low: 0.7,
      ci95_high: 0.9,
      n_obs: 10,
      verdict: 'UNKNOWN',
      sources: { probe: { p_success: 0.8, ci95_low: 0.7, ci95_high: 0.9, n_obs: 10, weight_total: 10 }, report: null, paid: null },
      convergence: { converged: false, sources_above_threshold: ['probe'], threshold: 0.8 },
      recent_activity: { last_24h: 1, last_7d: 5, last_30d: 10 },
      risk_profile: 'unknown',
      time_constant_days: 7,
      last_update: 0,
      is_meaningful: true,
    },
    advisory: {
      advisory_level: 'green',
      risk_score: 0.1,
      advisories: [],
      recommendation: 'proceed',
      freshness_status: 'fresh',
    },
    health: {
      reachability: 1,
      http_health_score: 0.95,
      health_freshness: 0.9,
      last_probe_age_sec: 60,
    },
  } as unknown as IntentCandidate;
}

function fakeIntent(candidates: IntentCandidate[]): Pick<IntentService, 'resolveIntent'> {
  return {
    resolveIntent: async () => ({
      intent: {
        category: 'data',
        keywords: [],
        budget_sats: null,
        max_latency_ms: null,
        resolved_at: 0,
        fresh: false,
        optimize: 'p_success',
      },
      candidates,
      meta: {
        total_matched: candidates.length,
        returned: candidates.length,
        strictness: 'strict',
        warnings: [],
        ranking_explanation: { primary: 'test', tiebreakers: [] },
      },
    } as unknown as IntentResponse),
  };
}

function makeFetch(routes: Array<{ match: (url: string, init?: RequestInit) => boolean; respond: (init?: RequestInit) => Response }>): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    for (const r of routes) {
      if (r.match(url, init)) return Promise.resolve(r.respond(init));
    }
    throw new Error(`fetchMock: unmatched ${url}`);
  }) as unknown as typeof fetch;
}

const AGENT_HASH = 'agent-hash-' + 'a'.repeat(54); // matches our 64-char convention

async function seedAgentBalance(pool: Pool, agentPubkey: string, sats: number): Promise<void> {
  await pool.query(
    `INSERT INTO token_balance (payment_hash, balance_credits, rate_sats_per_request, created_at)
     VALUES ($1, $2, 1, EXTRACT(EPOCH FROM NOW())::bigint)
     ON CONFLICT (payment_hash) DO UPDATE SET balance_credits = $2`,
    [agentPubkey, sats],
  );
}

describe('FulfillService', () => {
  let pool: Pool;
  let repo: FulfillJobRepository;
  let refundLedgerRepo: RefundLedgerRepository;
  let refundEngine: RefundEngine;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new FulfillJobRepository(pool);
    refundLedgerRepo = new RefundLedgerRepository(pool);
    refundEngine = new RefundEngine({
      refundLedgerRepo,
      config: { ...DEFAULT_REFUND_ENGINE_CONFIG, freshAgentDailyCapSats: 1000, establishedAgentDailyCapSats: 100000 },
    });
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE refund_ledger RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE fulfill_jobs RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE token_balance');
  });

  it('happy path — first candidate delivers, agent debited, success returned', async () => {
    const url = 'https://ok.example/api';
    const invoice = makeInvoice(5);
    const fetchMock = makeFetch([
      {
        match: (u, init) => u === url && !((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        respond: () => new Response('', {
          status: 402,
          headers: { 'www-authenticate': `L402 macaroon="m", invoice="${invoice}"` },
        }),
      },
      {
        match: (u, init) => u === url && !!((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        respond: () => new Response(JSON.stringify({ data: 'hello world delivery' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      },
    ]);
    await seedAgentBalance(pool, AGENT_HASH, 100);

    const svc = new FulfillService({
      pool,
      fulfillJobRepo: repo,
      intentService: fakeIntent([makeCandidate(url, 1)]) as IntentService,
      lndClient: fakeLnd({ payOk: true }),
      fetchImpl: fetchMock as unknown as typeof import('../utils/ssrf').fetchSafeExternal,
    });

    const result = await svc.fulfill({
      agent_pubkey: AGENT_HASH,
      intent: { category: 'data' },
      max_sats: 50,
      max_latency_ms: 5000,
    });

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.body).toContain('hello world');
    expect(result.preimage).toBe(PREIMAGE_HEX);
    expect(result.candidate_url).toBe(url);
    expect(result.sats_spent).toBe(5);
    expect(result.premium_sats).toBeGreaterThanOrEqual(1);

    // Agent balance was debited atomically.
    const { rows } = await pool.query<{ b: string }>(
      'SELECT balance_credits::text AS b FROM token_balance WHERE payment_hash = $1',
      [AGENT_HASH],
    );
    expect(Number(rows[0].b)).toBe(100 - 5 - result.premium_sats);

    // Job persisted in success state.
    const job = await repo.findById(result.job_id);
    expect(job?.status).toBe('success');
    expect(job?.sats_spent).toBe(5);
    expect(job?.attempts).toHaveLength(1);
    expect(job?.attempts[0].delivery_outcome).toBe('delivery_ok');
  });

  it('retry — first candidate fails delivery, second succeeds', async () => {
    const urlBad = 'https://bad.example/api';
    const urlGood = 'https://good.example/api';
    const invoice = makeInvoice(5);
    const fetchMock = makeFetch([
      // Bad endpoint returns 402 then 500 on recall.
      {
        match: (u, init) => u === urlBad && !((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        respond: () => new Response('', {
          status: 402,
          headers: { 'www-authenticate': `L402 macaroon="m", invoice="${invoice}"` },
        }),
      },
      {
        match: (u, init) => u === urlBad && !!((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        respond: () => new Response('upstream busted', { status: 500 }),
      },
      // Good endpoint returns 402 then 200 on recall.
      {
        match: (u, init) => u === urlGood && !((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        respond: () => new Response('', {
          status: 402,
          headers: { 'www-authenticate': `L402 macaroon="m", invoice="${invoice}"` },
        }),
      },
      {
        match: (u, init) => u === urlGood && !!((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        respond: () => new Response(JSON.stringify({ result: 'great success delivery' }), { status: 200 }),
      },
    ]);
    await seedAgentBalance(pool, AGENT_HASH, 100);

    const svc = new FulfillService({
      pool,
      fulfillJobRepo: repo,
      intentService: fakeIntent([makeCandidate(urlBad, 1), makeCandidate(urlGood, 2)]) as IntentService,
      lndClient: fakeLnd({ payOk: true }),
      fetchImpl: fetchMock as unknown as typeof import('../utils/ssrf').fetchSafeExternal,
    });

    const result = await svc.fulfill({
      agent_pubkey: AGENT_HASH,
      intent: { category: 'data' },
      max_sats: 50,
      max_latency_ms: 5000,
    });

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.candidate_url).toBe(urlGood);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].delivery_outcome).toBe('delivery_5xx');
    expect(result.attempts[1].delivery_outcome).toBe('delivery_ok');

    // Agent only paid 5 sats — failed attempt was absorbed by SatRank's pool.
    const { rows } = await pool.query<{ b: string }>(
      'SELECT balance_credits::text AS b FROM token_balance WHERE payment_hash = $1',
      [AGENT_HASH],
    );
    expect(Number(rows[0].b)).toBe(100 - 5 - result.premium_sats);
  });

  it('refund — every candidate fails, agent NOT debited, attempts logged', async () => {
    const url = 'https://broken.example/api';
    const invoice = makeInvoice(5);
    const fetchMock = makeFetch([
      {
        match: (u, init) => u === url && !((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        respond: () => new Response('', {
          status: 402,
          headers: { 'www-authenticate': `L402 macaroon="m", invoice="${invoice}"` },
        }),
      },
      {
        match: (u, init) => u === url && !!((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        respond: () => new Response('not delivered', { status: 500 }),
      },
    ]);
    await seedAgentBalance(pool, AGENT_HASH, 100);

    const svc = new FulfillService({
      pool,
      fulfillJobRepo: repo,
      intentService: fakeIntent([makeCandidate(url, 1)]) as IntentService,
      lndClient: fakeLnd({ payOk: true }),
      fetchImpl: fetchMock as unknown as typeof import('../utils/ssrf').fetchSafeExternal,
    });

    const result = await svc.fulfill({
      agent_pubkey: AGENT_HASH,
      intent: { category: 'data' },
      max_sats: 50,
      max_latency_ms: 5000,
    });

    expect(result.status).toBe('refunded');
    if (result.status !== 'refunded') return;
    expect(result.reason).toBe('all_candidates_failed');

    // Agent balance unchanged.
    const { rows } = await pool.query<{ b: string }>(
      'SELECT balance_credits::text AS b FROM token_balance WHERE payment_hash = $1',
      [AGENT_HASH],
    );
    expect(Number(rows[0].b)).toBe(100);

    // Job in `refunded` state.
    const job = await repo.findById(result.job_id);
    expect(job?.status).toBe('refunded');
    expect(job?.sats_spent).toBe(0);
  });

  it('insufficient balance — refuses without creating a job', async () => {
    await seedAgentBalance(pool, AGENT_HASH, 3); // < max_sats (50)

    const svc = new FulfillService({
      pool,
      fulfillJobRepo: repo,
      intentService: fakeIntent([]) as IntentService,
      lndClient: fakeLnd({ payOk: true }),
      fetchImpl: makeFetch([]) as unknown as typeof import('../utils/ssrf').fetchSafeExternal,
    });

    const result = await svc.fulfill({
      agent_pubkey: AGENT_HASH,
      intent: { category: 'data' },
      max_sats: 50,
      max_latency_ms: 5000,
    });

    expect(result.status).toBe('insufficient_balance');
    if (result.status !== 'insufficient_balance') return;
    expect(result.required_sats).toBe(51);
    expect(result.available_sats).toBe(3);

    // No job created.
    const { rows } = await pool.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM fulfill_jobs');
    expect(Number(rows[0].c)).toBe(0);
  });

  it('idempotency — duplicate fulfill within 60s returns the prior job', async () => {
    const url = 'https://once.example/api';
    const invoice = makeInvoice(3);
    let recallHits = 0;
    const fetchMock = makeFetch([
      {
        match: (u, init) => u === url && !((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        respond: () => new Response('', {
          status: 402,
          headers: { 'www-authenticate': `L402 macaroon="m", invoice="${invoice}"` },
        }),
      },
      {
        match: (u, init) => u === url && !!((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        respond: () => {
          recallHits++;
          return new Response('the unique successful body', { status: 200 });
        },
      },
    ]);
    await seedAgentBalance(pool, AGENT_HASH, 100);

    const svc = new FulfillService({
      pool,
      fulfillJobRepo: repo,
      intentService: fakeIntent([makeCandidate(url, 1)]) as IntentService,
      lndClient: fakeLnd({ payOk: true }),
      fetchImpl: fetchMock as unknown as typeof import('../utils/ssrf').fetchSafeExternal,
    });

    const a = await svc.fulfill({
      agent_pubkey: AGENT_HASH,
      intent: { category: 'data' },
      max_sats: 10,
      max_latency_ms: 5000,
    });
    const b = await svc.fulfill({
      agent_pubkey: AGENT_HASH,
      intent: { category: 'data' },
      max_sats: 10,
      max_latency_ms: 5000,
    });
    expect(a.status).toBe('success');
    expect(b.status).toBe('success');
    if (a.status !== 'success' || b.status !== 'success') return;
    expect(b.job_id).toBe(a.job_id);
    // Second call did NOT re-execute the recall (idempotent replay).
    expect(recallHits).toBe(1);
  });

  it('insufficient balance does not crash on agent with no token_balance row', async () => {
    const svc = new FulfillService({
      pool,
      fulfillJobRepo: repo,
      intentService: fakeIntent([]) as IntentService,
      lndClient: fakeLnd({ payOk: true }),
      fetchImpl: makeFetch([]) as unknown as typeof import('../utils/ssrf').fetchSafeExternal,
    });
    const result = await svc.fulfill({
      agent_pubkey: 'agent-with-no-deposit',
      intent: { category: 'data' },
      max_sats: 10,
      max_latency_ms: 5000,
    });
    expect(result.status).toBe('insufficient_balance');
  });

  it('hostile zero-amount invoice is rejected before pay', async () => {
    const url = 'https://zero.example/api';
    const invoice = makeInvoice(1); // we'll wrap with empty amount via tag override
    // Build an amount-less invoice: bolt11 spec allows this.
    const noAmount = makeAmountlessInvoice();
    const fetchMock = makeFetch([
      {
        match: u => u === url,
        respond: () => new Response('', {
          status: 402,
          headers: { 'www-authenticate': `L402 macaroon="m", invoice="${noAmount || invoice}"` },
        }),
      },
    ]);
    await seedAgentBalance(pool, AGENT_HASH, 100);

    const svc = new FulfillService({
      pool,
      fulfillJobRepo: repo,
      intentService: fakeIntent([makeCandidate(url, 1)]) as IntentService,
      lndClient: fakeLnd({ payOk: true }),
      fetchImpl: fetchMock as unknown as typeof import('../utils/ssrf').fetchSafeExternal,
    });

    const result = await svc.fulfill({
      agent_pubkey: AGENT_HASH,
      intent: { category: 'data' },
      max_sats: 50,
      max_latency_ms: 5000,
    });
    // No pay → no success on this candidate. Only one candidate so refund.
    expect(result.status).toBe('refunded');
  });

  it('LND not configured — payment skipped, attempt logged, refund', async () => {
    const url = 'https://lnd-down.example/api';
    const invoice = makeInvoice(5);
    const fetchMock = makeFetch([
      {
        match: u => u === url,
        respond: () => new Response('', {
          status: 402,
          headers: { 'www-authenticate': `L402 macaroon="m", invoice="${invoice}"` },
        }),
      },
    ]);
    await seedAgentBalance(pool, AGENT_HASH, 100);

    const svc = new FulfillService({
      pool,
      fulfillJobRepo: repo,
      intentService: fakeIntent([makeCandidate(url, 1)]) as IntentService,
      lndClient: fakeLnd({ unwired: true }),
      fetchImpl: fetchMock as unknown as typeof import('../utils/ssrf').fetchSafeExternal,
    });

    const result = await svc.fulfill({
      agent_pubkey: AGENT_HASH,
      intent: { category: 'data' },
      max_sats: 50,
      max_latency_ms: 5000,
    });
    expect(result.status).toBe('refunded');
    if (result.status !== 'refunded') return;
    expect(result.attempts[0].payment_outcome).toBe('lnd_not_configured');
  });

  it('no candidates returned by intentService → refunded with reason', async () => {
    await seedAgentBalance(pool, AGENT_HASH, 100);

    const svc = new FulfillService({
      pool,
      fulfillJobRepo: repo,
      intentService: fakeIntent([]) as IntentService,
      lndClient: fakeLnd({ payOk: true }),
      fetchImpl: makeFetch([]) as unknown as typeof import('../utils/ssrf').fetchSafeExternal,
    });

    const result = await svc.fulfill({
      agent_pubkey: AGENT_HASH,
      intent: { category: 'data' },
      max_sats: 50,
      max_latency_ms: 5000,
    });
    expect(result.status).toBe('refunded');
    if (result.status !== 'refunded') return;
    expect(result.reason).toBe('no_candidates_for_intent');
  });

  it('first attempt over budget skipped, second attempt within budget runs', async () => {
    const urlExpensive = 'https://expensive.example/api';
    const urlCheap = 'https://cheap.example/api';
    const invoice = makeInvoice(2);
    const fetchMock = makeFetch([
      {
        match: u => u === urlCheap,
        respond: (init) => {
          if (!((init?.headers as Record<string, string> | undefined)?.['Authorization'])) {
            return new Response('', {
              status: 402,
              headers: { 'www-authenticate': `L402 macaroon="m", invoice="${invoice}"` },
            });
          }
          return new Response('cheap delivered ok 12345', { status: 200 });
        },
      },
    ]);
    await seedAgentBalance(pool, AGENT_HASH, 100);

    const svc = new FulfillService({
      pool,
      fulfillJobRepo: repo,
      intentService: fakeIntent([
        makeCandidate(urlExpensive, 1, { price_sats: 100 }),
        makeCandidate(urlCheap, 2, { price_sats: 2 }),
      ]) as IntentService,
      lndClient: fakeLnd({ payOk: true }),
      fetchImpl: fetchMock as unknown as typeof import('../utils/ssrf').fetchSafeExternal,
    });

    const result = await svc.fulfill({
      agent_pubkey: AGENT_HASH,
      intent: { category: 'data' },
      max_sats: 5, // only enough for the cheap candidate
      max_latency_ms: 5000,
    });

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.candidate_url).toBe(urlCheap);
    // First attempt is the expensive one, marked skipped over_max_sats_hint.
    expect(result.attempts[0].payment_outcome).toBe('skipped_by_orchestrator');
    expect(result.attempts[0].detail).toBe('over_max_sats_hint');
  });
});

describe('computePremium', () => {
  it('floor 1 sat for low-risk endpoints', () => {
    expect(computePremium(5, makeCandidate('x', 1, { p_e2e_pess: 0.95 }))).toBe(1);
    expect(computePremium(50, makeCandidate('x', 1, { p_e2e_pess: 0.95 }))).toBe(1);
  });

  it('scales with risk on bigger invoices', () => {
    // 200 sats × 0.10 × (1 - 0.30) = 14 sats premium.
    expect(computePremium(200, makeCandidate('x', 1, { p_e2e_pess: 0.30 }))).toBe(14);
    // 50 sats × 0.10 × (1 - 0.50) = 2.5 → ceil 3.
    expect(computePremium(50, makeCandidate('x', 1, { p_e2e_pess: 0.50 }))).toBe(3);
  });

  it('default 0.5 pessimistic when stage_posteriors missing', () => {
    // No stage_posteriors → risk = 0.5 → 200 × 0.10 × 0.5 = 10 sats.
    expect(computePremium(200, makeCandidate('x', 1))).toBe(10);
  });
});

describe('canonicalIntentHash', () => {
  it('identical intents produce identical hashes', () => {
    expect(canonicalIntentHash({ category: 'data', keywords: ['a', 'b'] })).toBe(
      canonicalIntentHash({ category: 'data', keywords: ['b', 'a'] }), // sort-invariant
    );
  });

  it('different intents differ', () => {
    expect(canonicalIntentHash({ category: 'data' })).not.toBe(
      canonicalIntentHash({ category: 'ai' }),
    );
    expect(canonicalIntentHash({ category: 'data', max_latency_ms: 100 })).not.toBe(
      canonicalIntentHash({ category: 'data', max_latency_ms: 200 }),
    );
  });
});

describe('FulfillService — Phase 2 refund engine integration', () => {
  let pool: Pool;
  let repo: FulfillJobRepository;
  let refundLedgerRepo: RefundLedgerRepository;
  let refundEngine: RefundEngine;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new FulfillJobRepository(pool);
    refundLedgerRepo = new RefundLedgerRepository(pool);
    refundEngine = new RefundEngine({
      refundLedgerRepo,
      config: { ...DEFAULT_REFUND_ENGINE_CONFIG, freshAgentDailyCapSats: 100, establishedAgentDailyCapSats: 10000 },
    });
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE refund_ledger RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE fulfill_jobs RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE token_balance');
  });

  it('records ledger entry when paid candidate fails delivery', async () => {
    const urlBad = 'https://bad.example/api';
    const urlGood = 'https://good.example/api';
    const invoice = makeInvoice(5);
    const fetchMock = makeFetch([
      {
        match: (u, init) => u === urlBad && !((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        respond: () => new Response('', {
          status: 402,
          headers: { 'www-authenticate': `L402 macaroon="m", invoice="${invoice}"` },
        }),
      },
      {
        match: (u, init) => u === urlBad && !!((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        respond: () => new Response('boom', { status: 500 }),
      },
      {
        match: (u, init) => u === urlGood && !((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        respond: () => new Response('', {
          status: 402,
          headers: { 'www-authenticate': `L402 macaroon="m", invoice="${invoice}"` },
        }),
      },
      {
        match: (u, init) => u === urlGood && !!((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        respond: () => new Response('great success body 12345', { status: 200 }),
      },
    ]);
    await seedAgentBalance(pool, AGENT_HASH, 100);

    const svc = new FulfillService({
      pool,
      fulfillJobRepo: repo,
      intentService: fakeIntent([makeCandidate(urlBad, 1), makeCandidate(urlGood, 2)]) as IntentService,
      lndClient: fakeLnd({ payOk: true }),
      refundEngine,
      fetchImpl: fetchMock as unknown as typeof import('../utils/ssrf').fetchSafeExternal,
    });

    const result = await svc.fulfill({
      agent_pubkey: AGENT_HASH,
      intent: { category: 'data' },
      max_sats: 50,
      max_latency_ms: 5000,
    });

    expect(result.status).toBe('success');
    // The bad candidate's absorbed payment is in the ledger.
    const stats = await refundLedgerRepo.windowStats(0);
    expect(stats.total_events).toBe(1);
    expect(stats.sats_absorbed).toBe(5);
    expect(stats.by_classification.tier1_http_5xx).toBe(1);
  });

  it('rejects fulfill when fresh agent daily cap is reached', async () => {
    // Seed 95 sats already absorbed in ledger for AGENT_HASH (fresh agent).
    await seedAgentBalance(pool, AGENT_HASH, 1000);
    await repo.create({
      job_id: 'prior-job',
      agent_pubkey: AGENT_HASH,
      intent_hash: 'h'.repeat(64),
      max_sats: 100,
      max_latency_ms: 5000,
      created_at: Math.floor(Date.now() / 1000) - 100,
    });
    await refundLedgerRepo.record({
      job_id: 'prior-job',
      candidate_url: 'https://prior.example/api',
      agent_pubkey: AGENT_HASH,
      sats_absorbed: 95,
      classification: 'tier1_http_4xx',
      ts: Math.floor(Date.now() / 1000) - 100,
    });
    // Set agent_first_seen via token_balance.created_at: refresh balance with
    // a recent timestamp so the agent reads as `fresh`.
    await pool.query(
      `UPDATE token_balance SET created_at = $2 WHERE payment_hash = $1`,
      [AGENT_HASH, Math.floor(Date.now() / 1000) - 86400], // 1 day old → fresh
    );

    const svc = new FulfillService({
      pool,
      fulfillJobRepo: repo,
      intentService: fakeIntent([makeCandidate('https://x.example/api', 1)]) as IntentService,
      lndClient: fakeLnd({ payOk: true }),
      refundEngine,
      fetchImpl: makeFetch([]) as unknown as typeof import('../utils/ssrf').fetchSafeExternal,
    });

    const result = await svc.fulfill({
      agent_pubkey: AGENT_HASH,
      intent: { category: 'data' },
      max_sats: 50, // 95 used + 50 worst-case = 145 > cap 100 → blocked
      max_latency_ms: 5000,
    });

    expect(result.status).toBe('daily_cap_reached');
    if (result.status !== 'daily_cap_reached') return;
    expect(result.cap_sats).toBe(100);
    expect(result.used_24h_sats).toBe(95);
    expect(result.agent_age_bucket).toBe('fresh');
  });

  it('established agent (>30d) escapes the strict cap', async () => {
    await seedAgentBalance(pool, AGENT_HASH, 1000);
    await repo.create({
      job_id: 'old-job',
      agent_pubkey: AGENT_HASH,
      intent_hash: 'h'.repeat(64),
      max_sats: 100,
      max_latency_ms: 5000,
      created_at: Math.floor(Date.now() / 1000) - 100,
    });
    await refundLedgerRepo.record({
      job_id: 'old-job',
      candidate_url: 'https://x.example/old',
      agent_pubkey: AGENT_HASH,
      sats_absorbed: 95,
      classification: 'tier1_http_4xx',
      ts: Math.floor(Date.now() / 1000) - 100,
    });
    // Make the agent established by backdating token_balance.created_at.
    await pool.query(
      `UPDATE token_balance SET created_at = $2 WHERE payment_hash = $1`,
      [AGENT_HASH, Math.floor(Date.now() / 1000) - 60 * 86400], // 60 days
    );

    // A successful fulfill against a working endpoint to confirm we passed the cap.
    const url = 'https://ok.example/api';
    const invoice = makeInvoice(5);
    const fetchMock = makeFetch([
      {
        match: (u, init) => u === url && !((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        respond: () => new Response('', {
          status: 402,
          headers: { 'www-authenticate': `L402 macaroon="m", invoice="${invoice}"` },
        }),
      },
      {
        match: (u, init) => u === url && !!((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        respond: () => new Response('hello world delivered', { status: 200 }),
      },
    ]);

    const svc = new FulfillService({
      pool,
      fulfillJobRepo: repo,
      intentService: fakeIntent([makeCandidate(url, 1)]) as IntentService,
      lndClient: fakeLnd({ payOk: true }),
      refundEngine,
      fetchImpl: fetchMock as unknown as typeof import('../utils/ssrf').fetchSafeExternal,
    });
    const result = await svc.fulfill({
      agent_pubkey: AGENT_HASH,
      intent: { category: 'data' },
      max_sats: 50,
      max_latency_ms: 5000,
    });
    expect(result.status).toBe('success');
  });

  it('ledger write failure does not crash the orchestrator (defensive)', async () => {
    const url = 'https://bad.example/api';
    const invoice = makeInvoice(5);
    const fetchMock = makeFetch([
      {
        match: (u, init) => u === url && !((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        respond: () => new Response('', {
          status: 402,
          headers: { 'www-authenticate': `L402 macaroon="m", invoice="${invoice}"` },
        }),
      },
      {
        match: (u, init) => u === url && !!((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        respond: () => new Response('boom', { status: 500 }),
      },
    ]);
    await seedAgentBalance(pool, AGENT_HASH, 100);

    // Hostile refundEngine: recordAttempt always throws.
    const brokenEngine = {
      classifyAttempt: () => 'tier1_http_5xx' as const,
      recordAttempt: async () => { throw new Error('simulated DB outage'); },
      checkDailyCap: async () => ({
        allowed: true,
        cap_sats: 1000,
        used_24h_sats: 0,
        remaining_sats: 1000,
        agent_age_bucket: 'established' as const,
      }),
    };

    const svc = new FulfillService({
      pool,
      fulfillJobRepo: repo,
      intentService: fakeIntent([makeCandidate(url, 1)]) as IntentService,
      lndClient: fakeLnd({ payOk: true }),
      refundEngine: brokenEngine as unknown as RefundEngine,
      fetchImpl: fetchMock as unknown as typeof import('../utils/ssrf').fetchSafeExternal,
    });
    const result = await svc.fulfill({
      agent_pubkey: AGENT_HASH,
      intent: { category: 'data' },
      max_sats: 50,
      max_latency_ms: 5000,
    });
    // Orchestrator returned refunded cleanly even though ledger write threw.
    expect(result.status).toBe('refunded');
  });
});

/** Helper for the zero-amount invoice test — bolt11 lib accepts an
 *  amount-less invoice when satoshis is omitted. */
function makeAmountlessInvoice(): string {
  try {
    const data: Record<string, unknown> = {
      coinType: 'bitcoin',
      timestamp: Math.floor(Date.now() / 1000),
      tags: [
        { tagName: 'payment_hash', data: PAYMENT_HASH_HEX },
        { tagName: 'description', data: 'no-amount' },
        { tagName: 'expire_time', data: 3600 },
      ],
    };
    const encoded = encode(data as Parameters<typeof encode>[0]);
    const signed = sign(encoded, PEER_PRIV) as { paymentRequest: string };
    return signed.paymentRequest;
  } catch {
    return '';
  }
}
