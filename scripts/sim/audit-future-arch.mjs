// SatRank deep audit — "is the system architecturally deep enough for the
// future autonomous-agent economy on Bitcoin?". Adversarial. Opus 4.7
// with extended thinking enabled (16k thinking tokens) for max depth.
//
// Usage :
//   ANTHROPIC_API_KEY=... node scripts/sim/audit-future-arch.mjs

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }
const MODEL = process.env.AUDIT_MODEL ?? 'claude-opus-4-7';
const TAG = process.env.AUDIT_TAG ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');
const THINKING_BUDGET = Number(process.env.AUDIT_THINKING_BUDGET ?? 16000);
const MAX_TOKENS = Number(process.env.AUDIT_MAX_TOKENS ?? 24000);
const OUT_DIR = path.join(__dirname, 'runs', `audit-future-arch-${TAG}`);
const RAW_DIR = path.join(OUT_DIR, 'raw');
fs.mkdirSync(RAW_DIR, { recursive: true });

const lensesPath = path.join(__dirname, 'audit-future-arch-lenses.json');
const { lenses } = JSON.parse(fs.readFileSync(lensesPath, 'utf8'));

const client = new Anthropic({ apiKey: API_KEY });

const CONTEXT = `# SatRank — strategic audit on agentic-economy fitness (2026-05-06)

## Mission
Founder Romain. Single dev (Claude Code). Identity = "Lightning-pur, sovereign infra,
no external dependency in the critical path. Vise l'excellence." Single objective :
build the system READY FOR AUTONOMOUS AI AGENTS. Not a side project, not a marketing
exercise — Romain is asking whether SatRank is architecturally deep enough to be THE
infrastructure of the agentic economy on Bitcoin in 2028-2030, or just a feature
shop that ships nice incremental wins.

## What SatRank does (concrete)
SatRank is a Lightning-native settlement layer for AI agents calling L402-priced APIs.
The founder has shipped, in 2026 alone :

### Catalogue layer
- 192 endpoints aggregated from 6 sources (402index, l402.directory, awesome-l402,
  well-known L402, Nostr 31402, RSS feeds), 27 categories
- Top 5 providers = 77% of catalogue (concentration risk)
- Phase 10 (2026-05-04) : POST /api/operator/register-endpoint with NIP-98 + DNS TXT
  attestation. Operators self-register with OpenAPI + recall_body_template +
  recommended_validators. **0 self-registered operators in production.**

### Trust signal layer
- Per-endpoint Bayesian posteriors p_success (probe-level) and p_e2e (5-stage
  composed : challenge / decode / paid_probe / delivery / validation)
- Cross-validator calibration (Phase 7.4) via /api/oracle/calibrations
- Phase 12.1 capability_inference_log : Anthropic-API-backfilled
  input_schema/output_schema/modalities/languages/freshness_sla/deterministic on
  358/358 endpoints with audit trail (run_id + prompt_hash + raw response)
- Phase 12.6 consecutive_5xx_count → auto-deprecate at 3 consecutive 5xx
- Phase 12.7 compound category synonyms (energy/intelligence → data/finance fallback +
  auto-fallback for unknown A/B compounds)
- Phase 12.8 consecutive_validator_violation_count → auto-deprecate body-shape repeat-offenders
- Phase 12.2 BM25 in-process inverted index over name+description+category+provider
- Phase 12.4 IntentRanker interface : LegacyRanker / Bm25HybridRanker / LlmRerankRanker
  (Claude Haiku rerank top-K). RANKER_MODE env flag (legacy/bm25/bm25_llm).
- Phase 12.9 OperatorReplayStateService — shared between fulfill (writes) + ranker
  (reads). Locked-out operators get score × 0.05 multiplier in BM25HybridRanker.
- Phase 12.5 GoldenCanaryService : 6 (intent_text, expected_endpoint_substr) pairs
  evaluated every 5 min for recall@K alerting. Currently 100% recall@5.

### Execution layer (Phase 6, schema v61)
- POST /api/fulfill — atomic delivery via hold-invoice non-custodial mode
- Two-step flow {mode:'hold'} → BOLT11 → /api/fulfill/:job_id/execute
- Reconcile cron cancels expired HTLCs ; payout cron pays operators on success
- Custodial token_balance v1 also supported (legacy mode)
- Premium pricing : max(1, ceil(invoice × 0.10 × (1 - p_e2e_pess)))
- Idempotency 60s
- NIP-98 auth + per-agent rate-limit (30/min keyed per-pubkey)

### Insurance layer (Phase 7, schema v63)
- operator_bonds + agent_claims tables. Operators post Lightning hold-invoice
  to bond N sats ; bond is locked, drained on validated misdelivery claims.
- ClaimEngine 1×/2×/3×/5× multipliers based on delivery outcome :
    delivery_low_quality / schema_violation : 1× refund
    delivery_5xx / 4xx / recall_network_error : 2× refund
    delivery_empty_body / body_read_timeout : 3× refund
    delivery_validator_violation : 5× refund (operator violated explicit DSL contract)
- 24h dispute window ; payout cron 60s
- /api/oracle/claims, /api/operator/claim/:id/dispute live
- Validator marketplace (Phase 7.4) : agents can register custom validators ;
  cross-validator calibration via Phase 9.1

### Audit layer (Phase 8, schema v64+v65)
- Ed25519 SignerService, public key e8646d7d... published at /.well-known/satrank-key
- POST /api/fulfill/:job_id/evidence returns Ed25519-signed bundle (job_id +
  attempts[] + preimage + body_sha256 + operator_pubkey + ts ranges + reason)
- DNS TXT operator attestation crawler (_satrank-operator.<domain>)
- SDK 1.5.0 with verifyEvidence helper

### Performance layer (Phase 9, schema v66+v67)
- Credit line (eliminates pre-pay starvation, agents borrow up to a cap based on
  reputation_score × bond)
- Result cache (repeated identical fulfills cost 0 sats — keyed by intent_hash + body_sha256
  + operator_pubkey ; TTL by category)
- Capability tokens (eliminates NIP-98 overhead within window)
- Speculative parallel probe (parallel stage 1-2 latency reduction)

### Agent symmetry layer (P11B, schemas v71-72)
- agent_bonds : symmetric to operator_bonds. Agents post stake → tier benefits.
  bronze (default) : 5/min rate, no credit, no cache writes
  silver (bond ≥ 1000 sats) : 30/min rate, credit ≤ bond/2, cache enabled
  gold (bond ≥ 10000 sats) : 300/min rate, credit ≤ bond
- agent_reputation_score : Bayesian Beta with Laplace smoothing on fulfill outcomes ;
  tier-gated by reputation × bond MIN.
- AgentSlashingService : score < 0.1 + total ≥ 10 + active bond → slash 10% of
  available bond (capped 1000 sats) per trigger. 24h cool-down.
- agent-bond settlement watcher (Phase 11B.6, schema v73) : LND lookup + settle
  on ACCEPTED, releasePending unlocks the bond. Phantom bonds (deposit invoice
  never paid) grant ZERO tier benefit.

### Structured error envelope (Phase 11A.2)
- Every non-2xx response carries : { error: ErrorCode, message, next_action,
  retry_after_ms?, evidence_ref?, requestId }
- next_action enum : retry / retry_other_operator / blacklist_operator / claim_bond
  / abort_lane / wait — gives agents programmatic recovery hints
- 30 typed ErrorCodes covering auth/state/SLA/external/claim/generic
- Backwards-compat : the "error" field is still a string ; envelope is additive

### Pubkey-only operator attestation (Phase 11A.3, schema v70)
- Alternative to DNS TXT for operators without DNS control (Heroku/Render/ngrok)
- Operator publishes pubkey at https://<host>/.well-known/satrank-operator-pubkey
- Verifier fetches via SSRF-safe fetchSafeExternal at registration cron tick

## Empirical performance — 6 sims (Sim 13 → Sim 18) measured 2026-05-04..06

| Sim | Indispensable | Useful | Nice | Superfluous | HARMFUL | pay_2xx | "no" votes |
|-----|---------------|--------|------|-------------|---------|---------|------------|
| 13  | 1             | 3      | 2    | 1           | 3       | 62.5%   | 6          |
| 14  | 1             | 5      | 2    | 1           | 1       | 70.0%   | 4          |
| 15  | 1             | 6      | 1    | 1           | 1       | 65.0%   | 5          |
| 16  | 2             | 3      | 2    | 0           | 3       | 60.0%   | 5          |
| 17  | 1             | 4      | 2    | 1           | 2       | 62.5%   | 3          |
| 18  | 1             | 1      | 6    | 2           | 0       | 37.5%   | 6          |

Each sim = 10 personas × 4 fulfill calls × Opus 4.7 evaluation. Real sats spent.

### a10 RegRetentionAI (compliance / regulator persona) is INDISPENSABLE for 6 consecutive sims
Direct quote from Sim 18 a10 verdict : *"For a regulatory retention persona, the
structured refund taxonomy + preimage-anchored attempt log is the entire product.
Without SatRank, I'd be parsing raw 402 challenges and reconciling LN payments by
hand to produce equivalent records. Without SatRank, an agent paying L402 endpoints
directly would have no normalized refund taxonomy to retain."*

This is the most defensible product surface SatRank has shipped : Phase 7 bonds +
Phase 8 evidence + P11A.2 envelope + body_sha256 form a stable, durable value prop
specifically for compliance/audit/regulator agents.

### Sim 18 finding : HARMFUL=0 first time in 18 sims
P12.6/P12.8/P12.9 collectively eliminated harmful catches at the cost of pay_2xx
dropping 62.5→37.5% (catalog concentration penalty — when one provider is
downranked the lane drains).

### a2 / a3 / a6 (market-intel / trading / news classification) consistently FAIL
Reasons across sims : dead Cloudflare 502 hosts, lightningenable replay-state,
bitcoinbenji /mempool returning 200 + "Could not reach Bitcoin Core", llm402.ai
priced over budget hint at 25 sats. **Catalog concentration is now the structural
ceiling.** No amount of better ranking invents new operators.

### Engineering ceiling diagnosis
After 6 sims of catalog-hygiene engineering (P12.0-P12.10), the variance band is
now wider than any single engineering move. pay_2xx ranges 37.5%-70% across sims.
Indispensable count fluctuates 1-2. The next bending of the curve requires
catalog growth (Phase 10 outreach), not more code.

## Market context

### x402 ecosystem (USDC on EVM, Coinbase-backed)
- 100× SatRank's volume today
- Simpler ergonomics : USDC payments on Base/Optimism, no Lightning channel
  management
- 402index.io aggregates both L402 and x402 ; SatRank deliberately ignores x402
- Concentration of capital : Coinbase backing means infrastructure investment
  roughly proportional to SatRank's would take 18-24 months for SatRank to match

### Lightning Labs Taproot Assets
- Mainnet 2026 ; enables USDC, USDT, RGB-style assets ON Lightning rails
- If adopted broadly, would obsolete L402's BTC-only thesis — agents could pay
  in USDC over Lightning channels
- LQWD AI Launchpad (concurrent Lightning-native agent payments) shipped 2026-04-27,
  positioning explicitly as Bitcoin agent economy infrastructure

### Anthropic MCP (Model Context Protocol)
- Standard for agent-tool coordination, payment NOT specified
- Could ship a default payment integration any quarter ; Anthropic's choice
  determines whether SatRank gets distribution or gets circumvented

### Nostr ecosystem
- NIP-98 HTTP auth (used by SatRank) is mainstream
- Nostr 31402 events (used by SatRank to discover endpoints) are still niche
- DVM (data vending machines, NIP-90) competes for "agent service marketplace"
  positioning

### Founder constraints
- Single dev. Romain decides product, Claude Code implements.
- Lightning-pure identity is HARD : "no x402 / no USDC / no EVM, even if volume
  100× larger today" (memory : feedback_lightning_pur 2026-04-30).
- "Vise l'excellence, ready pour l'économie agentique massive" (2026-05-04).
- Romain has explicitly requested adversarial counterpoint at every previous
  audit and pivoted accordingly.

## Prior audits (for context)

### Audit autonomy 2026-05-04 — 5/6 NOT_READY
6 lenses on agent autonomy. Convergent finding : operators bonded+attested+slashable,
agents anonymous free-riders. P11 shipped 9 phases since to address — symmetry now
present at data-model + service layer. 4/5 audit convergent fixes done.

### Audit semantic-rank-layer 2026-05-05 — 0 BEST / 4 OK / 1 WRONG
6 lenses on whether dense embeddings + HNSW were the right architecture. Audit
verdict : WRONG. BM25 + LLM-rerank-top-3 was the right default for current scale.
Founder pivoted ; P12 is the audit-revised stack. Subsequent sims confirmed BM25
synonyms work + replay-state penalty works ; engineering ceiling reached.

## What this audit is for

Romain just asked : "is our system architecturally deep enough for the agentic
economy on Bitcoin? Is our innovation profound enough to be essential to it?
How do we improve it?" He wants the most rigorous adversarial analysis we have
ever produced. He explicitly compared this audit's importance to the founding
strategy decisions.

Each lens auditor is an Opus 4.7 instance with 16k thinking tokens of extended
reasoning. Be brutal. Cite specific systems by name. Quantify probabilities.
Distinguish what SatRank does well from what it does ornamentally. Do not
flatter — Romain has already shipped 18 sims worth of corrections from
adversarial findings ; he wants the same rigor here.
`;

async function audit(lens) {
  const userPrompt = `Your audit lens is **${lens.name}** (${lens.id}).

Your sharp question is :
> ${lens.question}

Apply this lens with maximum adversarial rigor. The founder has explicitly asked
for the most serious audit produced to date — surface every blind spot, name
every concrete competitor, quantify every probability you can. Cite specific
protocols, products, papers, founders, dates. Make every claim falsifiable.

Return a single JSON object matching this schema EXACTLY (no surrounding prose,
no code fences, no commentary) :

{
  "lens_id": "${lens.id}",
  "lens_name": "${lens.name}",
  "verdict": "DEEP_ENOUGH" | "PARTIAL" | "INSUFFICIENT",
  "headline": "<≤30 words : the brutal one-line answer to the lens question>",
  "concrete_findings": [
    {
      "finding": "<concrete observation, ≤2 sentences, with names + numbers>",
      "evidence": "<cite the data : sim verdict, market figure, technical detail>",
      "severity": 1 | 2 | 3 | 4 | 5,
      "blocks_essentialness": true | false
    }
  ],
  "missing_innovations_or_layers": [
    {
      "name": "<short kebab-case>",
      "description": "<what to build that doesn't exist today, ≤3 sentences>",
      "defensibility_months": <int : how many months it takes a competitor to clone>,
      "leverage_score": 1 | 2 | 3 | 4 | 5
    }
  ],
  "competitive_threats": [
    {
      "competitor": "<name>",
      "threat": "<concrete failure scenario for SatRank>",
      "probability_2028": <float 0..1 of capturing > 50% of agentic economy>,
      "satrank_counter_move": "<specific action to take in next 6 months>"
    }
  ],
  "must_change_before_2028": [
    "<concrete shippable item 1>",
    "<concrete shippable item 2>"
  ],
  "blind_spots": [
    "<thing the founder is most likely missing on this axis>"
  ],
  "openings": "<≤120 words : what an agent-economy-essential SatRank looks like in 2028 that today's SatRank does NOT yet contain>"
}

Severity scale : 1=cosmetic, 3=strategically important, 5=existential.
Defensibility scale : how many months of full-time engineering work for a
well-funded competitor (Coinbase, Anthropic, LightningLabs) to reproduce the
innovation. >12 months = real moat ; ≤6 months = decorative.
Leverage scale : how much of the agentic-economy-essential gap this single
innovation closes.

Be honest. The founder is paying for depth, not encouragement.`;

  const t0 = Date.now();
  process.stderr.write(`[${lens.id}] start (${MODEL}, thinking=${THINKING_BUDGET})\n`);
  let attempt = 0;
  const maxAttempts = 3;
  while (true) {
    attempt += 1;
    try {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        system: CONTEXT,
        messages: [{ role: 'user', content: userPrompt }],
      });
      const text = resp.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n')
        .trim();
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

const verdictCounts = { DEEP_ENOUGH: 0, PARTIAL: 0, INSUFFICIENT: 0 };
const allFindings = [];
const allMissing = [];
const allThreats = [];
const allMustChange = [];
const allBlindSpots = [];
for (const r of results) {
  const p = r.parsed;
  if (!p) continue;
  verdictCounts[p.verdict] = (verdictCounts[p.verdict] ?? 0) + 1;
  for (const f of (p.concrete_findings ?? [])) allFindings.push({ lens: p.lens_name, ...f });
  for (const m of (p.missing_innovations_or_layers ?? [])) allMissing.push({ lens: p.lens_name, ...m });
  for (const t of (p.competitive_threats ?? [])) allThreats.push({ lens: p.lens_name, ...t });
  for (const m of (p.must_change_before_2028 ?? [])) allMustChange.push({ lens: p.lens_name, item: m });
  for (const b of (p.blind_spots ?? [])) allBlindSpots.push({ lens: p.lens_name, item: b });
}

const md = [
  `# SatRank — strategic audit on agentic-economy fitness — ${TAG}`,
  ``,
  `Model: ${MODEL}, thinking budget: ${THINKING_BUDGET}. ${results.length} lenses.`,
  `Total in=${results.reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0)} out=${results.reduce((a, r) => a + (r.usage?.output_tokens ?? 0), 0)} thinking=${results.reduce((a, r) => a + (r.usage?.cache_creation_input_tokens ?? 0), 0)}.`,
  ``,
  `## Verdict distribution`,
  ``,
  `- DEEP_ENOUGH: ${verdictCounts.DEEP_ENOUGH}`,
  `- PARTIAL: ${verdictCounts.PARTIAL}`,
  `- INSUFFICIENT: ${verdictCounts.INSUFFICIENT}`,
  ``,
  `## Per-lens summary`,
  ``,
  ...results.map(r => {
    const p = r.parsed;
    if (!p) return `### ${r.lens_id} — PARSE FAILED\n\n\`\`\`\n${r.raw_text.slice(0, 2000)}\n\`\`\`\n`;
    return [
      `### ${p.lens_id} — ${p.lens_name}`,
      ``,
      `**Verdict:** ${p.verdict}`,
      `**Headline:** ${p.headline}`,
      ``,
      `**Concrete findings (${(p.concrete_findings ?? []).length}):**`,
      ...(p.concrete_findings ?? []).map(f => `- [sev ${f.severity}${f.blocks_essentialness ? ', blocks essentialness' : ''}] ${f.finding} _(evidence: ${f.evidence})_`),
      ``,
      `**Missing innovations / layers (${(p.missing_innovations_or_layers ?? []).length}):**`,
      ...(p.missing_innovations_or_layers ?? []).map(m => `- **${m.name}** (defensibility ${m.defensibility_months} months, leverage ${m.leverage_score}) — ${m.description}`),
      ``,
      `**Competitive threats:**`,
      ...(p.competitive_threats ?? []).map(t => `- **${t.competitor}** (P_capture_2028=${t.probability_2028}) — ${t.threat} → counter: ${t.satrank_counter_move}`),
      ``,
      `**Must change before 2028:**`,
      ...(p.must_change_before_2028 ?? []).map(x => `- ${x}`),
      ``,
      `**Founder blind spots:**`,
      ...(p.blind_spots ?? []).map(b => `- ${b}`),
      ``,
      `**Openings:** ${p.openings}`,
      ``,
    ].join('\n');
  }),
  ``,
  `## Cross-lens severity≥4 findings`,
  ``,
  ...allFindings.filter(f => f.severity >= 4).sort((a, b) => b.severity - a.severity).map(f => `- [sev ${f.severity}] _(${f.lens})_ ${f.finding}`),
  ``,
  `## Cross-lens highest-leverage missing innovations`,
  ``,
  ...allMissing.filter(m => m.leverage_score >= 4).sort((a, b) => (b.leverage_score - a.leverage_score) || (b.defensibility_months - a.defensibility_months)).map(m => `- **${m.name}** _(${m.lens})_ — leverage ${m.leverage_score}, defensibility ${m.defensibility_months}m — ${m.description}`),
  ``,
  `## Cross-lens highest-probability competitive threats`,
  ``,
  ...allThreats.filter(t => t.probability_2028 >= 0.3).sort((a, b) => b.probability_2028 - a.probability_2028).map(t => `- **${t.competitor}** _(${t.lens})_ P=${t.probability_2028} — ${t.threat}`),
  ``,
  `## All must-change items (deduplicated by lens)`,
  ``,
  ...allMustChange.map(m => `- _(${m.lens})_ ${m.item}`),
  ``,
  `## All blind spots`,
  ``,
  ...allBlindSpots.map(b => `- _(${b.lens})_ ${b.item}`),
  ``,
].join('\n');

const aggPath = path.join(OUT_DIR, 'aggregate.md');
fs.writeFileSync(aggPath, md);
console.log(`Aggregate written to ${aggPath}`);
console.log(`Verdict distribution:`, verdictCounts);
