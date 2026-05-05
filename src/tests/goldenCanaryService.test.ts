// Phase 12.5 (2026-05-05) — golden canary tests.
import { describe, it, expect } from 'vitest';
import { GoldenCanaryService } from '../services/goldenCanaryService';
import type { IntentService } from '../services/intentService';

function makeFakeIntentService(behaviour: Record<string, string[]>): IntentService {
  return {
    async resolveIntent(req: { category: string; text?: string }) {
      const key = `${req.category}|${req.text ?? ''}`;
      const urls = behaviour[key] ?? behaviour[req.category] ?? [];
      return {
        intent: { category: req.category } as never,
        candidates: urls.map((url, i) => ({ endpoint_url: url, rank: i + 1 } as never)),
        meta: { total_matched: urls.length, returned: urls.length, strictness: 'strict', warnings: [], ranking_explanation: { primary: 'test', tiebreakers: [] } } as never,
      } as never;
    },
  } as unknown as IntentService;
}

describe('Phase 12.5 — GoldenCanaryService', () => {
  it('hits when expected substr appears in top-K url', async () => {
    const svc = new GoldenCanaryService({
      intentService: makeFakeIntentService({
        'data/finance|btc price': ['https://x.example/stock-quote/btc', 'https://y.example/other'],
      }),
      pairs: [
        { intent_text: 'btc price', category: 'data/finance', expected_endpoint_substr: 'stock-quote' },
      ],
      now: () => 1_000,
    });
    const r = await svc.run();
    expect(r.total).toBe(1);
    expect(r.hits).toBe(1);
    expect(r.recall_at_k).toBe(1);
    expect(r.per_pair[0].hit).toBe(true);
  });

  it('miss when expected substr absent from top-K', async () => {
    const svc = new GoldenCanaryService({
      intentService: makeFakeIntentService({
        'data/finance|btc price': ['https://wrong.example/audiobook', 'https://y.example/other'],
      }),
      pairs: [
        { intent_text: 'btc price', category: 'data/finance', expected_endpoint_substr: 'stock-quote' },
      ],
    });
    const r = await svc.run();
    expect(r.hits).toBe(0);
    expect(r.recall_at_k).toBe(0);
    expect(r.per_pair[0].hit).toBe(false);
  });

  it('case-insensitive substring match', async () => {
    const svc = new GoldenCanaryService({
      intentService: makeFakeIntentService({
        'data/finance|btc price': ['https://X.example/Stock-Quote/Realtime'],
      }),
      pairs: [
        { intent_text: 'btc price', category: 'data/finance', expected_endpoint_substr: 'stock-quote' },
      ],
    });
    const r = await svc.run();
    expect(r.hits).toBe(1);
  });

  it('multiple pairs aggregate recall', async () => {
    const svc = new GoldenCanaryService({
      intentService: makeFakeIntentService({
        'a|hit': ['https://hit.example/a/x'],
        'b|miss': ['https://wrong.example/y'],
        'c|hit2': ['https://hit2.example/x'],
      }),
      pairs: [
        { intent_text: 'hit', category: 'a', expected_endpoint_substr: 'hit.example' },
        { intent_text: 'miss', category: 'b', expected_endpoint_substr: 'expected.but.absent' },
        { intent_text: 'hit2', category: 'c', expected_endpoint_substr: 'hit2.example' },
      ],
    });
    const r = await svc.run();
    expect(r.total).toBe(3);
    expect(r.hits).toBe(2);
    expect(r.recall_at_k).toBeCloseTo(2 / 3, 3);
  });

  it('honours topK : substr present beyond top-K is a miss', async () => {
    const svc = new GoldenCanaryService({
      intentService: makeFakeIntentService({
        'a|x': ['https://1.example', 'https://2.example', 'https://3.example', 'https://target.example'],
      }),
      pairs: [
        { intent_text: 'x', category: 'a', expected_endpoint_substr: 'target.example' },
      ],
      topK: 3,
    });
    const r = await svc.run();
    expect(r.hits).toBe(0); // target.example is at index 3, beyond top-K=3
  });

  it('survives a single-pair throw (other pairs still scored)', async () => {
    const svc = new GoldenCanaryService({
      intentService: {
        async resolveIntent(req: { category: string; text?: string }) {
          if (req.text === 'broken') throw new Error('boom');
          return {
            intent: { category: req.category } as never,
            candidates: [{ endpoint_url: 'https://hit.example/x', rank: 1 } as never],
            meta: {} as never,
          } as never;
        },
      } as unknown as IntentService,
      pairs: [
        { intent_text: 'broken', category: 'a', expected_endpoint_substr: 'whatever' },
        { intent_text: 'ok', category: 'a', expected_endpoint_substr: 'hit.example' },
      ],
    });
    const r = await svc.run();
    expect(r.total).toBe(2);
    expect(r.hits).toBe(1);
  });

  it('records ranker_mode + observed_at + last result accessible', async () => {
    process.env.RANKER_MODE = 'bm25';
    const svc = new GoldenCanaryService({
      intentService: makeFakeIntentService({ 'a|x': ['https://hit.example'] }),
      pairs: [{ intent_text: 'x', category: 'a', expected_endpoint_substr: 'hit.example' }],
      now: () => 1_700_000_000,
    });
    expect(svc.getLastResult()).toBeNull();
    const r = await svc.run();
    expect(r.ranker_mode).toBe('bm25');
    expect(r.observed_at).toBe(1_700_000_000);
    expect(svc.getLastResult()).toEqual(r);
    delete process.env.RANKER_MODE;
  });

  it('empty pair list → recall=0, total=0', async () => {
    const svc = new GoldenCanaryService({
      intentService: makeFakeIntentService({}),
      pairs: [],
    });
    const r = await svc.run();
    expect(r.total).toBe(0);
    expect(r.hits).toBe(0);
    expect(r.recall_at_k).toBe(0);
  });
});
