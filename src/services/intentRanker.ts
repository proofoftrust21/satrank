// Phase 12.4 (2026-05-05) — IntentRanker interface + implementations.
//
// Per audit semantic-rank-layer 2026-05-05 :
//   - Layered abstraction (audit L2) lets us swap ranking strategies
//     without rewriting intentService. Required for the "ready forever"
//     contract Romain set.
//   - LegacyRanker = pre-P12 ordering (p_e2e DESC, p_success DESC).
//     Default RANKER_MODE preserves existing prod behaviour.
//   - Bm25HybridRanker = BM25 lexical signal blended with p_e2e.
//     0.5 BM25 + 0.5 p_e2e. Catches the Sim 13 hyperdope HLS misroute
//     (description mentions "video", intent says "trading data" —
//     BM25 zero-overlap drops it).
//   - LlmRerankRanker = BM25 narrow top-20 → Claude Haiku rerank top-N.
//     Highest leverage on Sim 14 HARMFUL (audit L4) : Haiku trivially
//     spots ai/classify ≠ audiobook semantic mismatch. Cost ~$0.003 per
//     query, gated behind RANKER_MODE so it stays optional.
//
// Future implementations (DenseHybridRanker, SpladeRanker, GbdtLtrRanker,
// CrossEncoderRanker) plug into the same interface — that's the
// audit-validated "tout prêt" contract.

import { logger } from '../logger';
import type { Bm25Service } from './bm25Service';

/** A candidate as built by intentService.compareCandidates. We intentionally
 *  keep this narrow to whatever the rankers actually need ; widening is
 *  cheap if a future ranker needs more fields. */
export interface RankCandidate {
  id: number;                       // service_endpoints.id (BM25 doc id)
  endpoint_url: string;
  service_name: string | null;
  description: string | null;
  category: string | null;
  provider: string | null;
  /** End-to-end Bayesian success probability (0..1). The legacy ranker
   *  sorts by this DESC. New rankers blend with lexical/semantic signal. */
  p_e2e_pessimistic: number;
  /** Auxiliary tiebreaker. Optional — not all candidates have it. */
  p_success: number;
  /** Median latency, used as a tertiary tiebreaker. ms. */
  median_latency_ms: number | null;
  /** Phase 12.9 (2026-05-06) — operator pubkey, used by the ranker to
   *  query the shared replay-state service and downrank candidates whose
   *  operator is in active lockout. Optional — null when the catalogue
   *  row has no operator linkage. */
  operator_pubkey?: string | null;
}

/** Phase 12.9 — narrowed interface so the ranker doesn't pull the full
 *  OperatorReplayStateService class type (avoids circular import risk). */
export interface ReplayStateLookup {
  isLockedOut(operatorPubkey: string): boolean;
}

/** Per-candidate score after ranking. The same candidate appears at the
 *  same index ; only the order may change. `score_breakdown` is a free-
 *  form JSON the explain mode (P12.5) can surface. */
export interface RankedCandidate {
  candidate: RankCandidate;
  score: number;
  rank: number;
  score_breakdown: Record<string, number>;
  reason?: string;
}

/** What every ranker exposes. Stateless ; tests can mock trivially. */
export interface IntentRanker {
  readonly id: 'legacy' | 'bm25_hybrid' | 'llm_rerank';
  rank(intentText: string, candidates: ReadonlyArray<RankCandidate>): Promise<RankedCandidate[]>;
}

// ---------------------------------------------------------------------------
// Phase 12.9 — shared helper : downrank a candidate by a fixed multiplier
// when its operator is in active replay lockout. Pushed strongly enough
// that any non-locked candidate ranks above. Returns the multiplier so
// callers can also expose it in score_breakdown.
//
// Phase 12.11 (Sim 20 follow-up, 2026-05-07) — Sim 20 a09 verbatim :
// "SatRank knew they were unhealthy yet still ranked them top-3". The 0.05
// multiplier alone is not enough when ALL top candidates of a category
// share one replay-storming operator (Lightning Enable proxy = ~80% of
// finance/data candidates). Multiplying everyone by 0.05 leaves the same
// top-3 ordering. Phase 12.11 introduces a HARD pre-filter via
// `filterReplayLockout` ; rankers call it first to drop locked-out
// candidates entirely. The 0.05 downrank is preserved as defense-in-depth
// for the (rare) case where some candidates of a category are locked AND
// some aren't — the non-locked ones rank above by a large margin.
// ---------------------------------------------------------------------------
const REPLAY_LOCKOUT_MULTIPLIER = 0.05;

function applyReplayLockout(
  candidate: RankCandidate,
  baseScore: number,
  replayState?: ReplayStateLookup,
): { score: number; locked: boolean } {
  if (!replayState || !candidate.operator_pubkey) return { score: baseScore, locked: false };
  if (!replayState.isLockedOut(candidate.operator_pubkey)) return { score: baseScore, locked: false };
  return { score: baseScore * REPLAY_LOCKOUT_MULTIPLIER, locked: true };
}

/** Phase 12.11 — hard pre-filter. Drops every candidate whose operator is
 *  currently in replay lockout. The intent surface should treat the result
 *  as "no_candidates" rather than ranking unhealthy operators top-K and
 *  letting the agent burn an RTT on a guaranteed `pay_skipped_replay_state`.
 *
 *  Returns `{ keep, dropped }` so callers can log / observe the drop ratio
 *  for the audit trail. When `replayState` is undefined (back-compat with
 *  tests), nothing is dropped. */
export function filterReplayLockout(
  candidates: ReadonlyArray<RankCandidate>,
  replayState?: ReplayStateLookup,
): { keep: RankCandidate[]; dropped: RankCandidate[] } {
  if (!replayState) return { keep: [...candidates], dropped: [] };
  const keep: RankCandidate[] = [];
  const dropped: RankCandidate[] = [];
  for (const c of candidates) {
    if (c.operator_pubkey && replayState.isLockedOut(c.operator_pubkey)) {
      dropped.push(c);
    } else {
      keep.push(c);
    }
  }
  return { keep, dropped };
}

// ---------------------------------------------------------------------------
// LegacyRanker — pre-P12 ordering. RANKER_MODE=legacy default ; back-compat
// for existing prod behaviour, default for tests that don't set up BM25.
// ---------------------------------------------------------------------------
export interface LegacyRankerOpts {
  replayState?: ReplayStateLookup;
}

export class LegacyRanker implements IntentRanker {
  readonly id = 'legacy' as const;
  private readonly replayState?: ReplayStateLookup;
  constructor(opts: LegacyRankerOpts = {}) {
    this.replayState = opts.replayState;
  }
  async rank(_text: string, candidates: ReadonlyArray<RankCandidate>): Promise<RankedCandidate[]> {
    // Phase 12.11 — hard filter replay-locked candidates.
    const { keep } = filterReplayLockout(candidates, this.replayState);
    const scored = keep.map(c => {
      // Defense-in-depth : applyReplayLockout still runs in case the
      // filter was a no-op (no replayState injected) — the locked branch
      // is unreachable when filter is active, but the breakdown shape
      // stays consistent with the pre-Phase-12.11 contract.
      const { score, locked } = applyReplayLockout(c, c.p_e2e_pessimistic, this.replayState);
      const breakdown: Record<string, number> = { p_e2e: c.p_e2e_pessimistic };
      if (locked) breakdown.replay_lockout = 1;
      return {
        candidate: c,
        score,
        rank: 0,
        score_breakdown: breakdown,
        reason: locked ? 'legacy_p_e2e_replay_lockout' : 'legacy_p_e2e_desc',
      };
    });
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.candidate.p_success !== a.candidate.p_success) {
        return b.candidate.p_success - a.candidate.p_success;
      }
      const aLat = a.candidate.median_latency_ms ?? Number.POSITIVE_INFINITY;
      const bLat = b.candidate.median_latency_ms ?? Number.POSITIVE_INFINITY;
      return aLat - bLat;
    });
    return scored.map((s, i) => ({
      candidate: s.candidate,
      score: s.score,
      rank: i + 1,
      score_breakdown: s.score_breakdown,
      reason: s.reason,
    }));
  }
}

// ---------------------------------------------------------------------------
// Bm25HybridRanker — BM25(0.5) + p_e2e(0.5).
// ---------------------------------------------------------------------------
export interface Bm25HybridOpts {
  bm25: Bm25Service;
  bm25Weight?: number;       // default 0.5
  pE2eWeight?: number;       // default 0.5
  /** Phase 12.9 — operator replay-state lookup. When supplied, locked-out
   *  operators are downranked so the agent doesn't burn an RTT on a
   *  candidate that fulfillService is going to skip pre-pay anyway. */
  replayState?: ReplayStateLookup;
}

export class Bm25HybridRanker implements IntentRanker {
  readonly id = 'bm25_hybrid' as const;
  private readonly bm25: Bm25Service;
  private readonly bm25Weight: number;
  private readonly pE2eWeight: number;
  private readonly replayState?: ReplayStateLookup;

  constructor(opts: Bm25HybridOpts) {
    this.bm25 = opts.bm25;
    this.bm25Weight = opts.bm25Weight ?? 0.5;
    this.pE2eWeight = opts.pE2eWeight ?? 0.5;
    this.replayState = opts.replayState;
  }

  async rank(intentText: string, candidates: ReadonlyArray<RankCandidate>): Promise<RankedCandidate[]> {
    if (candidates.length === 0) return [];
    if (!intentText || intentText.trim().length === 0) {
      // Fallback to legacy when caller didn't supply free text. Pass the
      // shared replay-state through so the locked-out downrank still
      // applies in the legacy fallback path.
      return new LegacyRanker({ replayState: this.replayState }).rank(intentText, candidates);
    }
    // Phase 12.11 — hard filter replay-locked candidates before scoring.
    const { keep } = filterReplayLockout(candidates, this.replayState);
    if (keep.length === 0) return [];
    const filtered = keep;
    // Compute raw BM25 scores per candidate. Normalise to [0, 1] by
    // dividing by the max so the hybrid weighting is meaningful.
    const rawScores = filtered.map(c => this.bm25.score(c.id, intentText));
    const maxRaw = rawScores.reduce((m, s) => (s > m ? s : m), 0);
    const norm = (s: number): number => (maxRaw > 0 ? s / maxRaw : 0);
    const scored = filtered.map((c, i) => {
      const bm25Norm = norm(rawScores[i]);
      const baseScore = this.bm25Weight * bm25Norm + this.pE2eWeight * c.p_e2e_pessimistic;
      // Phase 12.9 — apply replay-state lockout downrank.
      const { score, locked } = applyReplayLockout(c, baseScore, this.replayState);
      const breakdown: Record<string, number> = {
        bm25_raw: rawScores[i],
        bm25_norm: bm25Norm,
        p_e2e: c.p_e2e_pessimistic,
      };
      if (locked) breakdown.replay_lockout = 1;
      return {
        candidate: c,
        score,
        rank: 0,
        score_breakdown: breakdown,
        reason: locked ? 'bm25_hybrid_replay_lockout' : 'bm25_hybrid',
      };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s, i) => ({ ...s, rank: i + 1 }));
  }
}

// ---------------------------------------------------------------------------
// LlmRerankRanker — BM25 narrow top-20 → Claude Haiku rerank top-K.
// ---------------------------------------------------------------------------
export interface LlmRerankOpts {
  bm25: Bm25Service;
  /** Anthropic Messages create-compatible callable, injected for testing.
   *  Production wiring uses the @anthropic-ai/sdk client.messages.create. */
  llmCall: (req: LlmRerankRequest) => Promise<LlmRerankResponse>;
  /** How many BM25 candidates to send to the LLM. Default 20. */
  narrowTopK?: number;
  /** How many ranked candidates to return. Default 10. */
  finalTopK?: number;
  /** Fallback ranker used when the LLM call fails or times out. */
  fallback?: IntentRanker;
}

export interface LlmRerankRequest {
  intent_text: string;
  candidates: Array<{
    id: number;
    name: string | null;
    description: string | null;
    category: string | null;
    provider: string | null;
  }>;
  k: number;
}

export interface LlmRerankResponse {
  ranked: Array<{ id: number; reason?: string }>;
  raw?: unknown;
}

export class LlmRerankRanker implements IntentRanker {
  readonly id = 'llm_rerank' as const;
  private readonly bm25: Bm25Service;
  private readonly llmCall: (req: LlmRerankRequest) => Promise<LlmRerankResponse>;
  private readonly narrowTopK: number;
  private readonly finalTopK: number;
  private readonly fallback: IntentRanker;

  constructor(opts: LlmRerankOpts) {
    this.bm25 = opts.bm25;
    this.llmCall = opts.llmCall;
    this.narrowTopK = opts.narrowTopK ?? 20;
    this.finalTopK = opts.finalTopK ?? 10;
    this.fallback = opts.fallback ?? new LegacyRanker();
  }

  async rank(intentText: string, candidates: ReadonlyArray<RankCandidate>): Promise<RankedCandidate[]> {
    if (candidates.length === 0) return [];
    if (!intentText || intentText.trim().length === 0) {
      return this.fallback.rank(intentText, candidates);
    }
    // Step 1 : BM25 narrow. We need the actual candidates — caller is
    // expected to have fed buildIndex with these same docs. If BM25
    // returns nothing (empty index), fall back.
    const narrowed = this.narrowByBm25(intentText, candidates);
    if (narrowed.length === 0) return this.fallback.rank(intentText, candidates);

    // Step 2 : send the narrowed set to the LLM.
    let llmResp: LlmRerankResponse;
    try {
      llmResp = await this.llmCall({
        intent_text: intentText,
        candidates: narrowed.map(c => ({
          id: c.id,
          name: c.service_name,
          description: c.description,
          category: c.category,
          provider: c.provider,
        })),
        k: Math.min(this.finalTopK, narrowed.length),
      });
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'LlmRerankRanker: LLM call failed, falling back',
      );
      return this.fallback.rank(intentText, candidates);
    }

    // Step 3 : merge the LLM ranking back with the candidate metadata,
    // append BM25 tail in original order so we always return some result.
    const byId = new Map(candidates.map(c => [c.id, c]));
    const ranked: RankedCandidate[] = [];
    const seen = new Set<number>();
    for (const r of llmResp.ranked) {
      const c = byId.get(r.id);
      if (!c || seen.has(c.id)) continue;
      seen.add(c.id);
      ranked.push({
        candidate: c,
        score: 1 - ranked.length / Math.max(1, this.finalTopK), // monotone-decreasing
        rank: ranked.length + 1,
        score_breakdown: { llm_rank: ranked.length + 1 },
        reason: r.reason ?? 'llm_rerank',
      });
    }
    // Tail = BM25 narrowed not yet picked + the rest of original order.
    for (const c of narrowed) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      ranked.push({
        candidate: c,
        score: 0.5,
        rank: ranked.length + 1,
        score_breakdown: { bm25_tail: 1 },
        reason: 'bm25_tail',
      });
    }
    for (const c of candidates) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      ranked.push({
        candidate: c,
        score: 0,
        rank: ranked.length + 1,
        score_breakdown: { legacy_tail: 1 },
        reason: 'legacy_tail',
      });
    }
    return ranked;
  }

  private narrowByBm25(intentText: string, candidates: ReadonlyArray<RankCandidate>): RankCandidate[] {
    // Score every candidate via the same Bm25Service used for catalog
    // indexing. We rank by score and keep the top narrowTopK ; ties are
    // broken by p_e2e to favour higher-quality endpoints when BM25 is
    // ambivalent (very short intent, e.g. {"category": "data"}).
    const scored = candidates
      .map(c => ({ c, bm25: this.bm25.score(c.id, intentText) }))
      .sort((a, b) => {
        if (b.bm25 !== a.bm25) return b.bm25 - a.bm25;
        return b.c.p_e2e_pessimistic - a.c.p_e2e_pessimistic;
      })
      .slice(0, this.narrowTopK);
    return scored.map(s => s.c);
  }
}

// ---------------------------------------------------------------------------
// Production wiring — Anthropic Messages → LlmRerankResponse adapter.
// ---------------------------------------------------------------------------
const RERANK_PROMPT = `You are a routing oracle for an AI agent ecosystem.
The agent has expressed the intent below in free text.
Your job is to rerank the given candidate APIs from BEST to WORST match for
that intent. Consider:
  - Does the candidate's name+description+category actually fulfil the intent?
  - Beware of category miscategorisation (e.g. category=bitcoin but
    description shows it's a video stream — this is a misroute).
  - Beware of input/output format mismatch (e.g. intent wants JSON,
    description hints at audio file).
  - Use only the metadata provided. Do not invent capabilities.

Return STRICT JSON of shape:
{"ranked":[{"id":<int>,"reason":"<short string>"}]}
- "ranked" array contains the top {{K}} candidates, in order from best to
  worst. Length is at most {{K}}.
- "reason" is a short (<= 12 words) explanation per candidate.
- No additional fields, no markdown, no preamble, no commentary.

INTENT: {{INTENT}}

CANDIDATES (id, name, description, category, provider):
{{CANDIDATES}}`;

export function buildAnthropicRerankAdapter(deps: {
  client: { messages: { create: (req: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> } };
  model?: string;
  maxTokens?: number;
}): (req: LlmRerankRequest) => Promise<LlmRerankResponse> {
  const model = deps.model ?? 'claude-haiku-4-5-20251001';
  const maxTokens = deps.maxTokens ?? 800;
  return async (req) => {
    const candidatesText = req.candidates
      .map(c => `- id=${c.id} | name=${c.name ?? '(none)'} | category=${c.category ?? '(none)'} | provider=${c.provider ?? '(none)'} | desc=${(c.description ?? '').slice(0, 240)}`)
      .join('\n');
    const prompt = RERANK_PROMPT
      .replaceAll('{{K}}', String(req.k))
      .replace('{{INTENT}}', req.intent_text)
      .replace('{{CANDIDATES}}', candidatesText);
    const resp = await deps.client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = resp.content
      .filter(c => c.type === 'text')
      .map(c => c.text ?? '')
      .join('\n')
      .trim();
    let parsed: { ranked?: Array<{ id?: number; reason?: string }> };
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('LlmRerank: response is not valid JSON');
      parsed = JSON.parse(m[0]);
    }
    if (!Array.isArray(parsed.ranked)) throw new Error('LlmRerank: missing ranked[] in response');
    return {
      raw: text,
      ranked: parsed.ranked
        .filter(r => typeof r.id === 'number')
        .map(r => ({ id: r.id as number, reason: typeof r.reason === 'string' ? r.reason : undefined })),
    };
  };
}
