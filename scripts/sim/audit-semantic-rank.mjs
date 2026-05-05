// SatRank deep audit — "is the proposed semantic-rank architecture the best
// for our constraints?". Adversarial counterpoint to the dev's plan.
// Mirrors scripts/sim/audit-autonomy.mjs ; different context blob + lenses.

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }
const MODEL = process.env.AUDIT_MODEL ?? 'claude-opus-4-7';
const TAG = process.env.AUDIT_TAG ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');
const OUT_DIR = path.join(__dirname, 'runs', `audit-semrank-${TAG}`);
const RAW_DIR = path.join(OUT_DIR, 'raw');
fs.mkdirSync(RAW_DIR, { recursive: true });

const lensesPath = path.join(__dirname, 'audit-semantic-rank-lenses.json');
const { lenses } = JSON.parse(fs.readFileSync(lensesPath, 'utf8'));

const client = new Anthropic({ apiKey: API_KEY });

const CONTEXT = `# SatRank — semantic-rank-layer architecture audit (2026-05-05)

## Project context
SatRank is a Lightning-native settlement layer for AI agents calling L402-priced APIs.
Founder Romain. Single dev (Claude Code). Identity = "Lightning-pur, sovereign infra,
no external dependency in the critical path".

## Current state (post-P11)
- 192 endpoints in catalogue, 5 providers = 77% concentration
- Schema v73, dbStatus ok. Postgres 16 on cpx42 instance.
- API on cpx32 (4 vCPU, 8GB RAM, Hetzner Hetzner nbg1).
- Sim 14 (2026-05-05): pay_2xx 70%, 1 indispensable + 5 useful + 2 nice + 1 superfluous + 1 HARMFUL
- Stack already shipped: capability schema columns (P11A.1, mostly empty),
  structured error envelope (P11A.2), agent bonds + reputation + tier-gating (P11B.*).

## Sim 14 verdict diagnosis (what semantic-rank should fix)
- HARMFUL a03 (market-intel): "ai/classify routed to LLM/audiobook endpoints" —
  BM25 and dense embeddings would catch the semantic mismatch.
- Superfluous a09 (data-lineage): "catalog lacks compliance-oriented provenance APIs" —
  COVERAGE GAP, not a ranking problem. No ranking algorithm can fix this.
- Sim 13 hyperdope: video-stream HLS misroute under category=bitcoin —
  semantic match would have downranked.

About 1 in 4 Sim failures are addressable by semantic ranking.
3 in 4 are catalog coverage / outreach problems.

## Proposed plan (the architecture under audit)

### P12.0 — Capability backfill (one-shot)
- Use Anthropic API ($0.50, ~50 lines admin script)
- Populate input_schema/output_schema/modalities/languages/freshness_sla/deterministic
  on the 192 existing service_endpoints rows (columns already exist from P11A.1)
- capability_provenance = 'crawler_inferred' for back-fills, 'operator_signed' for Phase 10

### P12.1 — Embedding store
- Schema v74 : ALTER TABLE service_endpoints ADD COLUMN embedding REAL[] (384 dims),
  embedding_text_hash TEXT, embedding_updated_at INT
- Storage : ~1.5KB per endpoint, ~300KB for full 192 catalog, ~150MB at 100k

### P12.2 — BM25 implementation
- In-memory inverted index over (name + description + category + provider)
- Standard TF-IDF + BM25 scoring (k1=1.5, b=0.75)
- ~150 lines of code, no external dep
- Latency : <1ms even at 100k endpoints

### P12.3 — Dense embedding via onnxruntime-node
- Model : bge-small-en-v1.5 (384 dims, 22M params, ~30MB ONNX file)
- onnxruntime-node : C++ native binding, NOT WASM
- Latency : ~5-10ms per text on cpx32 CPU, ~2ms with batching
- Memory : ~50MB loaded model

### P12.4 — HNSW index via hnswlib-node
- In-memory HNSW (hierarchical navigable small world) index
- 384-dim vectors, ~5ms search at 1M endpoints
- Native binding, ~10MB compiled

### P12.5 — Hybrid scoring
- IntentRanker interface : input (intent.text, candidates[]) → scored[]
- Default formula : (BM25 × 0.3 + dense_cosine × 0.4 + p_e2e × 0.3)
- Configurable weights via env

### P12.6 — Explain mode
- /api/intent?explain=1 returns per-candidate rationale block:
  { semantic_score, p_e2e, bm25_score, dense_score, hybrid_score, reasoning_text }

### P12.7 — Backfill cron
- 60s tick : pick up service_endpoints WHERE embedding IS NULL OR
  embedding_text_hash != current_hash, embed in batch

### P12.8 — Tests + smoke
- Unit tests on BM25, cosine, HNSW lifecycle, hybrid scoring
- Integration test on full /api/intent path
- Smoke validation on prod after deploy

## Cost claims under audit

### Today (192 endpoints / ~1 qps)
$0/month delta. Existing cpx32 has spare capacity.

### 100k endpoints / 100 qps
- BM25 inverted index : ~30MB RAM
- Embedding storage : 150MB (REAL[] in Postgres)
- HNSW index : ~150-300MB RAM
- onnxruntime-node : ~50MB model, 4 cores can do ~200-400 qps
- Total RAM in API process : ~500MB-1GB ; cpx32 has 8GB
- Cost : $0/month delta

### 100k endpoints / 1k qps
- onnxruntime-node CPU saturates at ~400 qps single-process
- Need 2-3 Node processes or 1 dedicated cpx32 sidecar
- Cost : ~$15-30/month (1-2 extra cpx32)

### 100k endpoints / 10k qps
- 4-8 cpx32 nodes behind a load balancer
- Cost : ~$60-120/month

### 1M endpoints / 1k qps
- HNSW in-memory still fits (~3GB) but pushing single-node limits
- Migration : Qdrant single-node, ~$200-500/month
- Cost : ~$200-500/month

### 10M endpoints / 100k qps
- Qdrant sharded multi-node + GPU embedding sidecars
- Cost : ~$5-10k/month

## Migration interfaces (so future swaps are trivial)

\`\`\`typescript
interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}
// Default: OnnxLocalProvider (in-process)
// Future swap: OnnxSidecarProvider (HTTP) when 1k+ qps

interface VectorIndex {
  add(id: number, vec: Float32Array): void;
  search(query: Float32Array, k: number): Array<{ id: number; score: number }>;
}
// Default: HnswInMemoryIndex
// Future swap: QdrantRemoteIndex when 1M+ endpoints

interface IntentRanker {
  rank(intent: IntentRequest, candidates: Candidate[]): Promise<ScoredCandidate[]>;
}
// Default: HybridRanker(bm25Weight, denseWeight, pE2eWeight)
\`\`\`

## Constraints (hard)
- Lightning-pur identity : no external API in critical path (Anthropic API for
  capability backfill is one-shot, output stored in DB → acceptable)
- Single dev capacity : avoid solutions requiring full-time ops
- $0/month preferred for current state ; predictable cost growth as scale increases
- No vendor lock-in : every dependency must be swappable
- Founder explicitly said "vise l'excellence, prêt pour l'économie agentique massive"

## What the founder is NOT willing to accept
- OpenAI / Voyage / any external embedding API in the critical path (they
  multiply cost in O(qps) at scale)
- Per-call SaaS billing for the ranking layer
- Wait-and-see "we'll add it when needed" approach — wants the full stack
  ready now so future scale isn't a re-architecture

## What the founder asked for
"Tout doit etre prêt des maintenant, on vise l'excellence, ready pour l'économie
agentique sur Bitcoin"

## What the audit should answer
For each lens, evaluate the proposal RIGOROUSLY and identify:
- Where the plan is right (defend the choice with concrete reasoning)
- Where the plan is wrong or could be better (specific alternatives with numbers)
- A concrete VERDICT : BEST | OK | WRONG
- Specific changes the founder should consider before greenlighting code
`;

async function audit(lens) {
  const userPrompt = `Your audit lens is **${lens.name}** (${lens.id}).

Your sharp question is:
> ${lens.question}

Apply this lens with maximum rigor. You are a counterpoint reviewer ; the founder
explicitly asked for adversarial perspective on the plan above. Be concrete with
numbers, named alternatives, and actionable changes.

Return a single JSON object matching this schema EXACTLY (no surrounding prose,
no code fences, no commentary):

{
  "lens_id": "${lens.id}",
  "lens_name": "${lens.name}",
  "verdict": "BEST" | "OK" | "WRONG",
  "one_line_summary": "<≤30 words: state of the proposal on this axis>",
  "strengths_of_proposal": [
    "<concrete thing the proposal got right, with reasoning>"
  ],
  "weaknesses_or_gaps": [
    {
      "name": "<short kebab-case name>",
      "issue": "<concrete description, ≤2 sentences>",
      "impact": 1 | 2 | 3 | 4 | 5,
      "proposed_alternative": "<what the founder should consider instead>"
    }
  ],
  "must_change_before_ship": [
    "<concrete item 1>",
    "<concrete item 2>"
  ],
  "nice_to_have_changes": [
    "<concrete item 1>"
  ],
  "openings": "<≤80 words: what the BEST plan on this axis would have that this proposal does NOT>"
}

Severity scale 1=trivial, 3=should-fix, 5=blocks-go.

Be HONEST and SHARP. The founder is paying for adversarial depth. Cite concrete
alternatives (named tools, named models, named papers) where relevant. Where the
proposal is RIGHT, defend it explicitly so the founder knows the choice is
validated.`;

  const t0 = Date.now();
  process.stderr.write(`[${lens.id}] start (${MODEL})\n`);
  let attempt = 0;
  const maxAttempts = 3;
  while (true) {
    attempt += 1;
    try {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: CONTEXT,
        messages: [{ role: 'user', content: userPrompt }],
      });
      const text = resp.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
      const elapsed = Date.now() - t0;
      process.stderr.write(`[${lens.id}] DONE (${elapsed}ms, in=${resp.usage.input_tokens} out=${resp.usage.output_tokens})\n`);
      let parsed;
      try { parsed = JSON.parse(text); } catch (_e) {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { try { parsed = JSON.parse(m[0]); } catch (_e2) { /* fallthrough */ } }
      }
      const out = { lens_id: lens.id, raw_text: text, parsed, usage: resp.usage, elapsed_ms: elapsed };
      fs.writeFileSync(path.join(RAW_DIR, `${lens.id}.json`), JSON.stringify(out, null, 2));
      return out;
    } catch (e) {
      const msg = (e && e.message) || String(e);
      process.stderr.write(`[${lens.id}] attempt ${attempt} error: ${msg}\n`);
      if (attempt >= maxAttempts) throw e;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

const results = await Promise.all(lenses.map(audit));

const verdictCounts = { BEST: 0, OK: 0, WRONG: 0 };
const allWeaknesses = [];
const allMustChange = [];
for (const r of results) {
  const p = r.parsed;
  if (!p) continue;
  verdictCounts[p.verdict] = (verdictCounts[p.verdict] ?? 0) + 1;
  for (const w of (p.weaknesses_or_gaps ?? [])) allWeaknesses.push({ lens: p.lens_name, ...w });
  for (const m of (p.must_change_before_ship ?? [])) allMustChange.push({ lens: p.lens_name, item: m });
}

const md = [
  `# SatRank semantic-rank-layer audit — ${TAG}`,
  ``,
  `Model: ${MODEL}. ${results.length} lenses. Total in=${results.reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0)} out=${results.reduce((a, r) => a + (r.usage?.output_tokens ?? 0), 0)}.`,
  ``,
  `## Verdict distribution`,
  ``,
  `- BEST: ${verdictCounts.BEST}`,
  `- OK: ${verdictCounts.OK}`,
  `- WRONG: ${verdictCounts.WRONG}`,
  ``,
  `## Per-lens summary`,
  ``,
  ...results.map(r => {
    const p = r.parsed;
    if (!p) return `### ${r.lens_id} — PARSE FAILED\n\n\`\`\`\n${r.raw_text.slice(0, 1000)}\n\`\`\`\n`;
    return [
      `### ${p.lens_id} — ${p.lens_name}`,
      ``,
      `**Verdict:** ${p.verdict}  `,
      `**Summary:** ${p.one_line_summary}`,
      ``,
      `**Strengths of proposal:**`,
      ...(p.strengths_of_proposal ?? []).map(s => `- ${s}`),
      ``,
      `**Weaknesses/gaps:**`,
      ...(p.weaknesses_or_gaps ?? []).map(w => `- [impact ${w.impact}] **${w.name}** — ${w.issue} _(alternative: ${w.proposed_alternative})_`),
      ``,
      `**Must change before ship:**`,
      ...(p.must_change_before_ship ?? []).map(x => `- ${x}`),
      ``,
      `**Nice-to-have:**`,
      ...(p.nice_to_have_changes ?? []).map(x => `- ${x}`),
      ``,
      `**Openings:** ${p.openings}`,
      ``,
    ].join('\n');
  }),
  ``,
  `## Cross-lens must-change items`,
  ``,
  ...allMustChange.map(m => `- _(${m.lens})_ ${m.item}`),
  ``,
  `## Cross-lens weaknesses (impact ≥3)`,
  ``,
  ...allWeaknesses.filter(w => w.impact >= 3).sort((a, b) => b.impact - a.impact).map(w => `- [impact ${w.impact}] **${w.name}** _(${w.lens})_ — ${w.issue}`),
  ``,
].join('\n');

const aggPath = path.join(OUT_DIR, 'aggregate.md');
fs.writeFileSync(aggPath, md);
console.log(`Aggregate written to ${aggPath}`);
console.log(`Verdict distribution:`, verdictCounts);
