// Phase 12.4 (2026-05-05) — IntentRanker tests.
import { describe, it, expect, beforeEach } from 'vitest';
import { Bm25Service } from '../services/bm25Service';
import {
  LegacyRanker,
  Bm25HybridRanker,
  LlmRerankRanker,
  buildAnthropicRerankAdapter,
  type RankCandidate,
  type LlmRerankResponse,
  type LlmRerankRequest,
} from '../services/intentRanker';

function mk(id: number, partial: Partial<RankCandidate> & { name?: string; desc?: string } = {}): RankCandidate {
  return {
    id,
    endpoint_url: `https://x.example/api${id}`,
    service_name: partial.name ?? `Service ${id}`,
    description: partial.desc ?? `Description for ${id}`,
    category: partial.category ?? 'data',
    provider: partial.provider ?? 'TestCo',
    p_e2e_pessimistic: partial.p_e2e_pessimistic ?? 0.5,
    p_success: partial.p_success ?? 0.5,
    median_latency_ms: partial.median_latency_ms ?? null,
  };
}

describe('Phase 12.4 — LegacyRanker', () => {
  it('returns empty for empty input', async () => {
    const r = new LegacyRanker();
    expect(await r.rank('any', [])).toEqual([]);
  });

  it('orders by p_e2e DESC, ties broken by p_success then latency', async () => {
    const r = new LegacyRanker();
    const cands = [
      mk(1, { p_e2e_pessimistic: 0.5, p_success: 0.5, median_latency_ms: 200 }),
      mk(2, { p_e2e_pessimistic: 0.9, p_success: 0.5, median_latency_ms: 200 }),
      mk(3, { p_e2e_pessimistic: 0.9, p_success: 0.9, median_latency_ms: 500 }),
      mk(4, { p_e2e_pessimistic: 0.9, p_success: 0.9, median_latency_ms: 100 }),
    ];
    const ranked = await r.rank('whatever', cands);
    expect(ranked.map(c => c.candidate.id)).toEqual([4, 3, 2, 1]);
    expect(ranked[0].rank).toBe(1);
    expect(ranked[3].rank).toBe(4);
  });

  it('preserves the score_breakdown shape for downstream explain', async () => {
    const r = new LegacyRanker();
    const ranked = await r.rank('x', [mk(1, { p_e2e_pessimistic: 0.42 })]);
    expect(ranked[0].score_breakdown).toEqual({ p_e2e: 0.42 });
    expect(ranked[0].reason).toBe('legacy_p_e2e_desc');
  });
});

describe('Phase 12.4 — Bm25HybridRanker', () => {
  let bm25: Bm25Service;

  beforeEach(() => {
    bm25 = new Bm25Service();
  });

  it('falls back to legacy when intent text is empty', async () => {
    bm25.buildIndex([{ id: 1, text: 'bitcoin api' }]);
    const r = new Bm25HybridRanker({ bm25 });
    const ranked = await r.rank('', [
      mk(1, { p_e2e_pessimistic: 0.4 }),
      mk(2, { p_e2e_pessimistic: 0.8 }),
    ]);
    expect(ranked.map(c => c.candidate.id)).toEqual([2, 1]);
  });

  it('hybrid blends BM25 lexical match with p_e2e (Sim 13 hyperdope test)', async () => {
    // Simulate Sim 13 catalog : 1 = HLS video falsely tagged "bitcoin",
    // 2 = real bitcoin OHLC API, 1 has higher p_e2e but lexical mismatch.
    bm25.buildIndex([
      { id: 1, text: 'video stream HLS master.m3u8 playback' },
      { id: 2, text: 'Bitcoin OHLC API realtime trading' },
    ]);
    const r = new Bm25HybridRanker({ bm25 });
    const ranked = await r.rank('bitcoin trading data', [
      mk(1, { p_e2e_pessimistic: 0.88 }),  // hyperdope-equivalent
      mk(2, { p_e2e_pessimistic: 0.55 }),  // genuine bitcoin
    ]);
    // With BM25 zero overlap on doc 1, hybrid should drop it below doc 2.
    expect(ranked[0].candidate.id).toBe(2);
    expect(ranked[1].candidate.id).toBe(1);
  });

  it('weights are configurable', async () => {
    bm25.buildIndex([
      { id: 1, text: 'unrelated content' },
      { id: 2, text: 'bitcoin trading' },
    ]);
    // p_e2e-only ranker (bm25Weight=0) should ignore lexical signal.
    const r = new Bm25HybridRanker({ bm25, bm25Weight: 0, pE2eWeight: 1 });
    const ranked = await r.rank('bitcoin', [
      mk(1, { p_e2e_pessimistic: 0.9 }),
      mk(2, { p_e2e_pessimistic: 0.5 }),
    ]);
    expect(ranked[0].candidate.id).toBe(1); // p_e2e wins
  });

  it('exposes per-candidate score_breakdown for explain', async () => {
    bm25.buildIndex([{ id: 1, text: 'bitcoin trading' }]);
    const r = new Bm25HybridRanker({ bm25 });
    const ranked = await r.rank('bitcoin', [mk(1, { p_e2e_pessimistic: 0.6 })]);
    expect(ranked[0].score_breakdown).toHaveProperty('bm25_raw');
    expect(ranked[0].score_breakdown).toHaveProperty('bm25_norm');
    expect(ranked[0].score_breakdown).toHaveProperty('p_e2e');
    expect(ranked[0].reason).toBe('bm25_hybrid');
  });
});

describe('Phase 12.4 — LlmRerankRanker', () => {
  let bm25: Bm25Service;

  beforeEach(() => {
    bm25 = new Bm25Service();
    bm25.buildIndex([
      { id: 1, text: 'Bitcoin OHLC realtime API' },
      { id: 2, text: 'Audiobook narration generator' },
      { id: 3, text: 'LLM completion service' },
      { id: 4, text: 'Bitcoin Lightning channel scorecard' },
    ]);
  });

  it('returns empty for empty candidates', async () => {
    const r = new LlmRerankRanker({
      bm25,
      llmCall: async () => ({ ranked: [] }),
    });
    expect(await r.rank('bitcoin', [])).toEqual([]);
  });

  it('falls back when intent text is empty', async () => {
    let called = false;
    const r = new LlmRerankRanker({
      bm25,
      llmCall: async () => { called = true; return { ranked: [] }; },
    });
    const ranked = await r.rank('', [mk(1), mk(2)]);
    expect(called).toBe(false);
    expect(ranked.length).toBe(2);
  });

  it('passes BM25-narrowed top-K to LLM and returns ordered result', async () => {
    let received: LlmRerankRequest | null = null;
    const r = new LlmRerankRanker({
      bm25,
      llmCall: async (req) => {
        received = req;
        return { ranked: [{ id: 1, reason: 'best match for OHLC' }] };
      },
      narrowTopK: 3,
      finalTopK: 1,
    });
    const ranked = await r.rank('bitcoin OHLC', [
      mk(1, { name: 'BTC OHLC', desc: 'realtime' }),
      mk(2, { name: 'audiobook' }),
      mk(3, { name: 'LLM completion' }),
      mk(4, { name: 'channel scorecard' }),
    ]);
    expect(received).not.toBeNull();
    expect(received!.intent_text).toBe('bitcoin OHLC');
    expect(received!.candidates.length).toBeLessThanOrEqual(3);
    expect(ranked[0].candidate.id).toBe(1);
    expect(ranked[0].rank).toBe(1);
    expect(ranked[0].reason).toBe('best match for OHLC');
  });

  it('falls back to legacy on LLM error', async () => {
    const r = new LlmRerankRanker({
      bm25,
      llmCall: async () => { throw new Error('LLM down'); },
    });
    const ranked = await r.rank('bitcoin OHLC', [
      mk(1, { p_e2e_pessimistic: 0.3 }),
      mk(2, { p_e2e_pessimistic: 0.9 }),
    ]);
    expect(ranked[0].candidate.id).toBe(2); // legacy ordering
  });

  it('appends BM25 tail then legacy tail when LLM returns subset', async () => {
    const r = new LlmRerankRanker({
      bm25,
      llmCall: async () => ({ ranked: [{ id: 1 }] }), // LLM returns only 1
      narrowTopK: 2,
      finalTopK: 1,
    });
    const ranked = await r.rank('bitcoin', [
      mk(1),  // BM25 narrows to this + 1 more
      mk(4),
      mk(2),  // not in BM25 narrow → ends up in legacy_tail
    ]);
    expect(ranked.length).toBe(3); // all candidates accounted for
    expect(ranked[0].candidate.id).toBe(1);
    expect(ranked[0].reason).toBe('llm_rerank');
    // tail entries
    expect(ranked.find(r => r.candidate.id === 2)?.reason).toMatch(/tail/);
  });

  it('ignores LLM-returned ids that are not in candidates (safety)', async () => {
    const r = new LlmRerankRanker({
      bm25,
      llmCall: async () => ({ ranked: [{ id: 9999 }, { id: 1 }] }),
    });
    const ranked = await r.rank('bitcoin', [mk(1)]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].candidate.id).toBe(1);
  });
});

describe('Phase 12.4 — buildAnthropicRerankAdapter', () => {
  it('builds + parses a valid Anthropic JSON reply', async () => {
    const fakeClient = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: '{"ranked":[{"id":7,"reason":"clear match"}]}' }],
        }),
      },
    };
    const adapter = buildAnthropicRerankAdapter({ client: fakeClient });
    const out = await adapter({ intent_text: 'x', candidates: [], k: 3 });
    expect(out.ranked).toEqual([{ id: 7, reason: 'clear match' }]);
  });

  it('extracts JSON when wrapped in chatter / fenced block', async () => {
    const fakeClient = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: 'Here you go:\n```json\n{"ranked":[{"id":3}]}\n```\nThanks.' }],
        }),
      },
    };
    const adapter = buildAnthropicRerankAdapter({ client: fakeClient });
    const out = await adapter({ intent_text: 'x', candidates: [], k: 3 });
    expect(out.ranked).toEqual([{ id: 3 }]);
  });

  it('throws when response has no JSON object', async () => {
    const fakeClient = {
      messages: { create: async () => ({ content: [{ type: 'text', text: 'sorry no json here' }] }) },
    };
    const adapter = buildAnthropicRerankAdapter({ client: fakeClient });
    await expect(adapter({ intent_text: 'x', candidates: [], k: 3 })).rejects.toThrow(/not valid JSON/i);
  });

  it('drops malformed entries (missing id)', async () => {
    const fakeClient = {
      messages: { create: async () => ({ content: [{ type: 'text', text: '{"ranked":[{"id":1},{"reason":"no id"}]}' }] }) },
    };
    const adapter = buildAnthropicRerankAdapter({ client: fakeClient });
    const out = await adapter({ intent_text: 'x', candidates: [], k: 3 });
    expect(out.ranked).toEqual([{ id: 1, reason: undefined }]);
  });

  it('passes k+intent through to prompt', async () => {
    let captured: { messages?: Array<{ content: string }>; max_tokens?: number; model?: string } = {};
    const fakeClient = {
      messages: {
        create: async (req: unknown) => {
          captured = req as typeof captured;
          return { content: [{ type: 'text', text: '{"ranked":[]}' }] };
        },
      },
    };
    const adapter = buildAnthropicRerankAdapter({ client: fakeClient, model: 'test-model' });
    await adapter({ intent_text: 'fancy intent', candidates: [{ id: 1, name: 'X', description: null, category: null, provider: null }], k: 5 });
    expect(captured.model).toBe('test-model');
    expect(captured.messages?.[0].content).toContain('fancy intent');
    expect(captured.messages?.[0].content).toContain('top 5');
    expect(captured.messages?.[0].content).toContain('id=1');
  });
});
