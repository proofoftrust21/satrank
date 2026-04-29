// Phase 5.12 — paidProbeRunner : cycle complet L402 (probe → pay → recall)
// avec cost guards. Mock LND + mock fetch ; aucun paiement réel.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { encode, sign } from 'bolt11';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import {
  EndpointStagePosteriorsRepository,
  STAGE_PAYMENT,
  STAGE_DELIVERY,
  STAGE_QUALITY,
} from '../repositories/endpointStagePosteriorsRepository';
import { PaidProbeRunner } from '../services/paidProbeRunner';
import type { LndGraphClient } from '../crawler/lndGraphClient';

let testDb: TestDb;
const SELF_PUBKEY = '02' + 'a'.repeat(64);
const PEER_PUBKEY = '02' + 'b'.repeat(64);
const PRIV_PEER = Buffer.from('b'.repeat(64), 'hex');
const PRIV_SELF = Buffer.from('a'.repeat(64), 'hex');

function makeMainnetInvoice(amountSats: number, signWith: 'peer' | 'self' = 'peer'): string {
  const data: Record<string, unknown> = {
    coinType: 'bitcoin',
    timestamp: Math.floor(Date.now() / 1000),
    satoshis: amountSats,
    tags: [
      { tagName: 'payment_hash', data: 'c'.repeat(64) },
      { tagName: 'description', data: 'paid-probe test' },
      { tagName: 'expire_time', data: 3600 },
    ],
  };
  const encoded = encode(data as Parameters<typeof encode>[0]);
  const signed = sign(encoded, signWith === 'peer' ? PRIV_PEER : PRIV_SELF) as { paymentRequest: string };
  return signed.paymentRequest;
}

function fakeLnd(behavior: {
  payOk?: boolean;
  routingError?: boolean;
  unwired?: boolean;
}): LndGraphClient {
  if (behavior.unwired) {
    return { isConfigured: () => true } as unknown as LndGraphClient;
  }
  return {
    isConfigured: () => true,
    payInvoice: async () => {
      if (behavior.routingError) {
        return { paymentPreimage: '', paymentHash: '', paymentError: 'no_route' };
      }
      if (!behavior.payOk) {
        return { paymentPreimage: '', paymentHash: '', paymentError: 'unknown error' };
      }
      return { paymentPreimage: 'd'.repeat(64), paymentHash: 'c'.repeat(64) };
    },
  } as unknown as LndGraphClient;
}

function makeFetch(routes: Array<{ match: (url: string, init?: RequestInit) => boolean; respond: (init?: RequestInit) => Response }>): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    for (const r of routes) {
      if (r.match(url, init)) return Promise.resolve(r.respond(init));
    }
    throw new Error(`fetchMock: unmatched ${url}`);
  }) as unknown as typeof fetch;
}

describe('PaidProbeRunner', () => {
  let pool: Pool;
  let stagesRepo: EndpointStagePosteriorsRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    stagesRepo = new EndpointStagePosteriorsRepository(pool);
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  it('audit r3: POST-only endpoint — challenge fetch uses http_method=POST', async () => {
    // Repro of the prod bug: llm402.ai returns 405 on GET but 402 on POST.
    // The runner must use http_method=POST for the challenge fetch when the
    // catalogue says so. Otherwise the entire llm402.ai fleet (~11 endpoints)
    // sits in `probe_not_402` and never gets paid-probed.
    const url = 'https://post-only.test/v1/chat';
    const invoice = makeMainnetInvoice(5);
    let methodsSeen: string[] = [];
    const fetchMock = makeFetch([
      {
        match: (u, init) => {
          if (u !== url) return false;
          methodsSeen.push((init?.method ?? 'GET').toString());
          return true;
        },
        respond: (init) => {
          const isAuthorized = !!((init?.headers as Record<string, string> | undefined)?.['Authorization']);
          const method = (init?.method ?? 'GET').toString();
          if (method !== 'POST') return new Response('', { status: 405 });
          if (!isAuthorized) {
            return new Response('', {
              status: 402,
              headers: { 'WWW-Authenticate': `L402 macaroon="m", invoice="${invoice}"` },
            });
          }
          return new Response(JSON.stringify({ data: 'served' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        },
      },
    ]);
    const runner = new PaidProbeRunner({
      stagesRepo,
      lndClient: fakeLnd({ payOk: true }),
      fetchImpl: fetchMock,
    });
    const summary = await runner.runOnce({
      endpoints: [{ url, http_method: 'POST' }],
      maxPerProbeSats: 10,
      totalBudgetSats: 100,
      selfPubkey: SELF_PUBKEY,
    });
    expect(summary.outcomes.pay_ok).toBe(1);
    expect(summary.outcomes.probe_not_402).toBe(0); // would be 1 with the GET-only bug
    expect(methodsSeen.every(m => m === 'POST')).toBe(true);
    expect(summary.totalSpent).toBe(5);
  });

  it('happy path: pay_ok + delivery_ok → stages 3 et 4 success', async () => {
    const url = 'https://happy.test/api';
    const invoice = makeMainnetInvoice(5);
    let recallSeen = false;
    const fetchMock = makeFetch([
      {
        match: (u, init) => u === url && (init?.method ?? 'GET') === 'GET' && !((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        respond: () => new Response('', {
          status: 402,
          headers: {
            'WWW-Authenticate': `L402 macaroon="m", invoice="${invoice}"`,
          },
        }),
      },
      {
        match: (u, init) => u === url && !!((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        respond: () => {
          recallSeen = true;
          return new Response(JSON.stringify({ data: 'ok-payload-here-with-content' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      },
    ]);
    const runner = new PaidProbeRunner({
      stagesRepo,
      lndClient: fakeLnd({ payOk: true }),
      fetchImpl: fetchMock,
    });
    const summary = await runner.runOnce({
      endpoints: [{ url, http_method: 'GET' }],
      maxPerProbeSats: 10,
      totalBudgetSats: 100,
      selfPubkey: SELF_PUBKEY,
    });
    expect(summary.outcomes.pay_ok).toBe(1);
    expect(summary.deliveryOutcomes.delivery_ok).toBe(1);
    expect(summary.totalSpent).toBe(5);
    expect(recallSeen).toBe(true);

    const stages = await stagesRepo.findAllStages(url);
    expect(stages.get(STAGE_PAYMENT)?.alpha).toBeGreaterThan(stages.get(STAGE_PAYMENT)!.beta);
    expect(stages.get(STAGE_DELIVERY)?.alpha).toBeGreaterThan(stages.get(STAGE_DELIVERY)!.beta);
  });

  it('routing failure: stage 3 failure persisted, stage 4 not touched', async () => {
    const url = 'https://routing.test/api';
    const invoice = makeMainnetInvoice(5);
    const fetchMock = makeFetch([
      {
        match: u => u === url,
        respond: () => new Response('', {
          status: 402,
          headers: { 'WWW-Authenticate': `L402 macaroon="m", invoice="${invoice}"` },
        }),
      },
    ]);
    const runner = new PaidProbeRunner({
      stagesRepo,
      lndClient: fakeLnd({ routingError: true }),
      fetchImpl: fetchMock,
    });
    const summary = await runner.runOnce({
      endpoints: [{ url, http_method: 'GET' }],
      maxPerProbeSats: 10,
      totalBudgetSats: 100,
      selfPubkey: SELF_PUBKEY,
    });
    expect(summary.outcomes.pay_routing_failed).toBe(1);
    expect(summary.deliveryOutcomes.delivery_skipped).toBe(1);
    expect(summary.totalSpent).toBe(0);

    const stages = await stagesRepo.findAllStages(url);
    expect(stages.get(STAGE_PAYMENT)?.beta).toBeGreaterThan(stages.get(STAGE_PAYMENT)!.alpha);
    // Pas d'observation Stage 4 — il n'y avait rien à recall.
    expect(stages.has(STAGE_DELIVERY)).toBe(false);
  });

  it('cost guard: skipped_over_cap when invoice > maxPerProbeSats', async () => {
    const url = 'https://expensive.test/api';
    const invoice = makeMainnetInvoice(100); // way over the cap
    const fetchMock = makeFetch([
      {
        match: u => u === url,
        respond: () => new Response('', {
          status: 402,
          headers: { 'WWW-Authenticate': `L402 macaroon="m", invoice="${invoice}"` },
        }),
      },
    ]);
    const runner = new PaidProbeRunner({
      stagesRepo,
      lndClient: fakeLnd({ payOk: true }),
      fetchImpl: fetchMock,
    });
    const summary = await runner.runOnce({
      endpoints: [{ url, http_method: 'GET' }],
      maxPerProbeSats: 5, // invoice 100 > 5
      totalBudgetSats: 1000,
      selfPubkey: SELF_PUBKEY,
    });
    expect(summary.outcomes.skipped_over_cap).toBe(1);
    expect(summary.totalSpent).toBe(0);
    // Aucun stage observé — l'endpoint n'a pas eu sa chance, pénaliser
    // serait incorrect.
    const stages = await stagesRepo.findAllStages(url);
    expect(stages.has(STAGE_PAYMENT)).toBe(false);
  });

  it('cost guard: skipped_total_cap when accumulated spend would exceed budget', async () => {
    const urls = ['https://sum1.test/api', 'https://sum2.test/api', 'https://sum3.test/api'];
    const invoices = urls.map(() => makeMainnetInvoice(5));
    const fetchMock = makeFetch([
      {
        match: u => urls.includes(u),
        respond: () => {
          const idx = Math.min(urls.length - 1, 0); // get the right invoice
          // For simplicity, return same invoice for all — they're all 5 sats.
          return new Response('', {
            status: 402,
            headers: { 'WWW-Authenticate': `L402 macaroon="m", invoice="${invoices[idx]}"` },
          });
        },
      },
    ]);
    // For routes with auth header — return 200 OK (we're testing the cap, not delivery).
    const fetchMockWithAuth = ((url: string, init?: RequestInit) => {
      const hasAuth = !!((init?.headers as Record<string, string> | undefined)?.['Authorization']);
      if (hasAuth) return Promise.resolve(new Response(JSON.stringify({ data: 'ok-content' }), { status: 200 }));
      return fetchMock(url, init);
    }) as typeof fetch;
    const runner = new PaidProbeRunner({
      stagesRepo,
      lndClient: fakeLnd({ payOk: true }),
      fetchImpl: fetchMockWithAuth,
    });
    const summary = await runner.runOnce({
      endpoints: urls.map((u: string) => ({ url: u, http_method: 'GET' as const })),
      maxPerProbeSats: 10,
      totalBudgetSats: 8, // suffit pour 1 (5 sats) mais bloque la 2nd (10 > 8)
      selfPubkey: SELF_PUBKEY,
    });
    expect(summary.outcomes.pay_ok).toBe(1);
    expect(summary.outcomes.skipped_total_cap).toBe(2);
    expect(summary.totalSpent).toBe(5);
  });

  it('self-pay guard: invoice destined to satrank own LND is skipped', async () => {
    const url = 'https://self.test/api';
    const invoice = makeMainnetInvoice(5, 'self'); // signed with SELF priv key
    const fetchMock = makeFetch([
      {
        match: u => u === url,
        respond: () => new Response('', {
          status: 402,
          headers: { 'WWW-Authenticate': `L402 macaroon="m", invoice="${invoice}"` },
        }),
      },
    ]);
    const runner = new PaidProbeRunner({
      stagesRepo,
      lndClient: fakeLnd({ payOk: true }),
      fetchImpl: fetchMock,
    });
    // Derive the actual self pubkey by parsing our own invoice
    const { parseBolt11 } = await import('../utils/bolt11Parser');
    const parsed = parseBolt11(invoice);
    expect(parsed.payeeNodeKey).toBeTruthy();
    const summary = await runner.runOnce({
      endpoints: [{ url, http_method: 'GET' }],
      maxPerProbeSats: 10,
      totalBudgetSats: 100,
      selfPubkey: parsed.payeeNodeKey!,
    });
    expect(summary.outcomes.skipped_self_pay).toBe(1);
    expect(summary.totalSpent).toBe(0);
  });

  it('LND not wired: every endpoint returns skipped_no_lnd, zero observations', async () => {
    const url = 'https://no-lnd.test/api';
    const runner = new PaidProbeRunner({
      stagesRepo,
      lndClient: fakeLnd({ unwired: true }),
      fetchImpl: makeFetch([{
        match: () => true,
        respond: () => new Response('', { status: 402 }),
      }]),
    });
    const summary = await runner.runOnce({
      endpoints: [{ url, http_method: 'GET' }],
      maxPerProbeSats: 10,
      totalBudgetSats: 100,
      selfPubkey: SELF_PUBKEY,
    });
    expect(summary.outcomes.skipped_no_lnd).toBe(1);
    const stages = await stagesRepo.findAllStages(url);
    expect(stages.size).toBe(0);
  });

  it('delivery 4xx: stage 3 success but stage 4 failure', async () => {
    const url = 'https://broken-delivery.test/api';
    const invoice = makeMainnetInvoice(5);
    const fetchMock = ((u: string, init?: RequestInit) => {
      const hasAuth = !!((init?.headers as Record<string, string> | undefined)?.['Authorization']);
      if (!hasAuth) {
        return Promise.resolve(new Response('', {
          status: 402,
          headers: { 'WWW-Authenticate': `L402 macaroon="m", invoice="${invoice}"` },
        }));
      }
      // Recall returns 400 — endpoint validates request after payment.
      return Promise.resolve(new Response(JSON.stringify({ error: 'symbol field is required' }), { status: 400 }));
    }) as typeof fetch;
    const runner = new PaidProbeRunner({
      stagesRepo,
      lndClient: fakeLnd({ payOk: true }),
      fetchImpl: fetchMock,
    });
    const summary = await runner.runOnce({
      endpoints: [{ url, http_method: 'GET' }],
      maxPerProbeSats: 10,
      totalBudgetSats: 100,
      selfPubkey: SELF_PUBKEY,
    });
    expect(summary.outcomes.pay_ok).toBe(1);
    expect(summary.deliveryOutcomes.delivery_4xx).toBe(1);
    const stages = await stagesRepo.findAllStages(url);
    expect(stages.get(STAGE_PAYMENT)!.alpha).toBeGreaterThan(stages.get(STAGE_PAYMENT)!.beta);
    expect(stages.get(STAGE_DELIVERY)!.beta).toBeGreaterThan(stages.get(STAGE_DELIVERY)!.alpha);
  });

  it('Phase 5.13 — delivery_ok with high-quality body → quality_ok stage 5 success', async () => {
    const url = 'https://high-quality.test/api';
    const invoice = makeMainnetInvoice(5);
    const fetchMock = ((u: string, init?: RequestInit) => {
      const hasAuth = !!((init?.headers as Record<string, string> | undefined)?.['Authorization']);
      if (!hasAuth) {
        return Promise.resolve(new Response('', {
          status: 402,
          headers: { 'WWW-Authenticate': `L402 macaroon="m", invoice="${invoice}"` },
        }));
      }
      return Promise.resolve(new Response(
        JSON.stringify({
          symbol: 'BTC',
          price: 42500,
          currency: 'USD',
          timestamp: 1700000000,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
    }) as typeof fetch;
    const runner = new PaidProbeRunner({
      stagesRepo,
      lndClient: fakeLnd({ payOk: true }),
      fetchImpl: fetchMock,
    });
    const summary = await runner.runOnce({
      endpoints: [{ url, http_method: 'GET' }],
      maxPerProbeSats: 10,
      totalBudgetSats: 100,
      selfPubkey: SELF_PUBKEY,
    });
    expect(summary.qualityOutcomes.quality_ok).toBe(1);
    const stages = await stagesRepo.findAllStages(url);
    expect(stages.get(STAGE_QUALITY)?.alpha).toBeGreaterThan(stages.get(STAGE_QUALITY)!.beta);
  });

  it('Phase 5.13 — delivery_ok with low-quality body ("ok") → quality_low stage 5 failure', async () => {
    const url = 'https://low-quality.test/api';
    const invoice = makeMainnetInvoice(5);
    const fetchMock = ((u: string, init?: RequestInit) => {
      const hasAuth = !!((init?.headers as Record<string, string> | undefined)?.['Authorization']);
      if (!hasAuth) {
        return Promise.resolve(new Response('', {
          status: 402,
          headers: { 'WWW-Authenticate': `L402 macaroon="m", invoice="${invoice}"` },
        }));
      }
      // "ok" passe le >= 10 chars threshold delivery_ok mais échoue quality.
      // Pour vraiment hit delivery_ok il faut >= 10 chars. Mettons un body
      // trivial qui passe delivery mais échoue quality.
      return Promise.resolve(new Response(
        '{"error":"insufficient quota"}',
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
    }) as typeof fetch;
    const runner = new PaidProbeRunner({
      stagesRepo,
      lndClient: fakeLnd({ payOk: true }),
      fetchImpl: fetchMock,
    });
    const summary = await runner.runOnce({
      endpoints: [{ url, http_method: 'GET' }],
      maxPerProbeSats: 10,
      totalBudgetSats: 100,
      selfPubkey: SELF_PUBKEY,
    });
    expect(summary.deliveryOutcomes.delivery_ok).toBe(1);
    expect(summary.qualityOutcomes.quality_low).toBe(1);
    const stages = await stagesRepo.findAllStages(url);
    // Stage 4 (delivery) success — HTTP 2xx body >= 10
    expect(stages.get(STAGE_DELIVERY)!.alpha).toBeGreaterThan(stages.get(STAGE_DELIVERY)!.beta);
    // Stage 5 (quality) failure — body contains "insufficient" + "quota exceeded" patterns
    expect(stages.get(STAGE_QUALITY)!.beta).toBeGreaterThan(stages.get(STAGE_QUALITY)!.alpha);
  });

  it('maxProbesPerCycle limits the work even when more URLs are passed', async () => {
    const urls = ['https://a.test/x', 'https://b.test/y', 'https://c.test/z'];
    const fetchMock = makeFetch([{
      match: () => true,
      respond: () => new Response('', { status: 0 }), // probe_no_response
    }]);
    const runner = new PaidProbeRunner({
      stagesRepo,
      lndClient: fakeLnd({ payOk: true }),
      fetchImpl: fetchMock,
    });
    const summary = await runner.runOnce({
      endpoints: urls.map((u: string) => ({ url: u, http_method: 'GET' as const })),
      maxPerProbeSats: 10,
      totalBudgetSats: 100,
      maxProbesPerCycle: 2,
      selfPubkey: SELF_PUBKEY,
    });
    expect(summary.results.length).toBe(2);
  });
});
