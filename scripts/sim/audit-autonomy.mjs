// SatRank deep audit — "is the system READY for autonomous agents?".
// Dispatches N parallel auditor lenses via the Anthropic Messages API, each
// with the same curated context blob and a sharp lens-specific question.
// Aggregates verdicts into runs/audit-autonomy-<YYYYMMDD>/{aggregate.md,raw/}.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/sim/audit-autonomy.mjs
//
// Env:
//   AUDIT_MODEL    (default claude-opus-4-7) — model to use for auditors
//   AUDIT_TAG      (default YYYYMMDD)         — appended to run dir name

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }
const MODEL = process.env.AUDIT_MODEL ?? 'claude-opus-4-7';
const TAG = process.env.AUDIT_TAG ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');
const OUT_DIR = path.join(__dirname, 'runs', `audit-autonomy-${TAG}`);
const RAW_DIR = path.join(OUT_DIR, 'raw');
fs.mkdirSync(RAW_DIR, { recursive: true });

const lensesPath = path.join(__dirname, 'audit-autonomy-lenses.json');
const { lenses } = JSON.parse(fs.readFileSync(lensesPath, 'utf8'));

const client = new Anthropic({ apiKey: API_KEY });

const CONTEXT = `# SatRank — system snapshot 2026-05-04 (post-Sim 13 fixes)

## Mission (Romain, founder)
Build a system READY FOR AUTONOMOUS AI AGENTS. Lightning-pur (no x402/USDC/EVM). Vise l'excellence. Single objective.

## Stack shipped (commit 715e04c, schema v68)

### Catalog layer
- 192 endpoints visible via /api/services, 27 categories
- Top 5 providers = 77% of catalog: llm402.ai (63), Lightning Enable (46), Bitcoin Benji (16), Lightning Faucet (13), Boltwork (10)
- Category distribution: ai/* 49%, data/* 17%, others ≤9% each
- Sources: 402index, l402.directory, awesome-l402, well-known L402, Nostr 31402, RSS
- Phase 10 self-registration (commit 4cba406) — POST /api/operator/register-endpoint with NIP-98 + DNS TXT verification, recall_body_template auto-derive. Currently 0 self-registered operators in production.

### Trust signal layer
- Per-endpoint Bayesian posteriors p_success (probe-level) and p_e2e (end-to-end pessimistic over 5 stages)
- 5 stages: stage 1 (HTTP 402 challenge), stage 2 (decode), stage 3 (paid probe), stage 4 (delivery), stage 5 (validation)
- Paid probes opt-in via PAID_PROBE_ENABLED, capped 12000 sats reserve, 5 sats × 10 endpoints × 4 cycles/day
- Cross-validator calibration (Phase 7.4) via /api/oracle/calibrations
- Per-category /api/intent now returns 1-3 distinct p_success after Phase 5/5.5/5.6 unblocked posterior diversity
- Pre-filter slow candidates (Sim 12 fix) at deadline-1500ms via median_latency

### Execution layer (Phase 6, schema v61)
- POST /api/fulfill — atomic delivery via hold-invoice non-custodial mode (commit 69c7337)
- Two-step flow: agent posts {mode:'hold'} → SatRank returns BOLT11 → agent settles → /api/fulfill/:job_id/execute
- Reconcile cron cancels expired HTLCs
- Custodial token_balance v1 also supported (legacy mode)
- Premium pricing: max(1, ceil(invoice × 0.10 × (1-p_e2e_pess))) sats above invoice
- Idempotency 60s
- NIP-98 auth + per-agent rate-limit (30/min, keyed per-pubkey)
- FULFILL_ENABLED gate currently ON, FULFILL_POOL_MIN_SATS=0 transitorily for Sim 9-13

### Insurance layer (Phase 7, schema v63)
- operator_bonds + agent_claims tables
- ClaimEngine 1×/2×/3×/5× multipliers based on delivery outcome
- 24h dispute window
- Validator marketplace + payout cron 60s
- /api/oracle/claims, /api/operator/claim/:id/dispute live

### Audit layer (Phase 8, schema v64+v65)
- Ed25519 SignerService, public key e8646d7d...
- POST /api/fulfill/:job_id/evidence returns signed bundle
- /.well-known/satrank-key endpoint
- DNS TXT operator attestation crawler (_satrank-operator.<domain>)
- SDK 1.5.0 with verifyEvidence helper

### Performance layer (Phase 9, schema v66+v67)
- Credit line (eliminates pre-pay starvation, agents can borrow up to a cap)
- Result cache (repeated identical fulfills cost 0 sats — keyed by intent_hash)
- Capability tokens (eliminates NIP-98 overhead for repeat agents within a window)
- Speculative parallel probe (parallel stage 1-2 latency reduction)

### Sim 13 runtime fixes (commit 851699d + 715e04c, no schema change)
- Fix 1.1 — pre-pay deadline gate (aborts before LND if budget elapsed)
- Fix 1.2 — operator replay state (skips operator after 2 pay_invoice_replayed in 5min)
- Fix 1.3 — JSON error-shape gate → delivery_validator_violation (5x bond claim)
- Fix 1.4 — RefundEngine handles delivery_validator_violation + aborted_for_sla
- Fix 2 — strict FULFILL_MAX_PER_OPERATOR=2 cap, no overflow refill
- Fix 3 — media-URL filter (.m3u8/.mp4/etc dropped from candidate pool)

## Live prod metrics (just measured)
- Schema v68, dbStatus ok, lndStatus ok
- 8308 agents indexed (4171 stale)
- 428,823 total transactions in agent index
- 3 federation peers
- 48 fulfill jobs all-time, 16 success / 32 refunded → success_rate 33.3%
- 220 sats spent, 22 premium revenue, pool absorbed 1141 sats (negative balance -1018)
- 24h: 18 absorbed events, 321 sats absorbed
- Top absorbed reason: tier1_recall_network_error (8/18 24h events)

## Sim trajectory (10 personas each, paying real sats)
- Sim 11 (2026-05-02): pay_2xx 55%, indispensable 1, useful 2, HARMFUL 2 — NO-GO
- Sim 12 (2026-05-02): pay_2xx 72.5%, indispensable 2, useful 3, HARMFUL 2
- Sim 13 (2026-05-04): pay_2xx 62.5%, indispensable 1, useful 3, HARMFUL 3 — REGRESSION
- Sim 14 staged (Sim 13 fixes deployed)

## Sim 13 verdicts cited verbatim
- a10 RegRetentionAI (regulator persona): "visibly_improved_vs_prior_sim: yes" — explicit citation of Phase 7+8 evidence bundle as indispensable for compliance
- a02/a05/a06/a08: 4 agents paid 10 sats each for hyperdope.com/master.m3u8 (HLS video) tagged category=bitcoin upstream — pure misroute due to zero semantic awareness in ranking
- a02 finance lane bricked: 4/5 candidates from operator 1fc6fff... (Lightning Enable proxies) all hit by replay storm, replay-state pre-check (Fix 1.2) skipped them all → no fallback

## Identity & auth primitives
- Agent identity: Nostr secp256k1 pubkey via NIP-98 HTTP authentication
- Operator identity: Nostr pubkey + DNS TXT attestation (_satrank-operator.<domain>)
- Validator identity: Nostr pubkey, registered via Phase 7.4 marketplace
- SatRank node identity: Ed25519 key (separate from Nostr) for evidence signing
- LND node pubkey: 028d62...

## Known gaps deliberately deferred
- Operator dashboard UI (only JSON API exists)
- Bond_id integration with rank prior (column exists, no flow)
- Phase 10 operator outreach (0 self-registered)
- Cross-operator semantic ranking (zero content awareness)
- ai/* parameterised endpoints (bitcoinbenji /classify needs {text:...}, /summarize needs {task:...}) → workaround via recall_body_template, but only works once operator registers
- Coverage gaps: energy/intelligence 0 candidates; weather/podcasts/etc 1-3 only
- token_balance v1 is custodial — no on-chain receipt, no third-party balance proof
- ANTHROPIC_API_KEY rotation does not automatically update sim runners
- M4 preimage encryption + L3 scoped macaroon deferred from Phase 6.1 audit

## Romain's design constraints (hard)
- Lightning only — no x402 / USDC / EVM (even though pan-402 volume is 100x larger today)
- Privacy first — agent identity must remain pseudonymous
- Reports = real txns only — no synthetic data
- score ≠ success_rate — Bayesian per-endpoint, not aggregated
- temporal aggregation — degrade old observations
- No cohabitation — replace endpoints, not add parallel ones
`;

async function audit(lens) {
  const userPrompt = `Your audit lens is **${lens.name}** (${lens.id}).

Your sharp question is:
> ${lens.question}

Apply this lens with maximum rigor. Return a single JSON object matching this schema EXACTLY (no surrounding prose, no code fences, no commentary):

{
  "lens_id": "${lens.id}",
  "lens_name": "${lens.name}",
  "verdict": "READY" | "GAPS" | "NOT_READY",
  "one_line_summary": "<≤25 words: state of the lens for autonomous agents>",
  "gaps": [
    {
      "name": "<short kebab-case name>",
      "scenario": "<concrete failure scenario in ≤2 sentences — must be falsifiable>",
      "current_workaround": "<is there one today? what does it cost the agent?>",
      "severity": 1 | 2 | 3 | 4 | 5,
      "blocks_autonomy": true | false
    }
  ],
  "fixes_to_converge": [
    {
      "name": "<short kebab-case>",
      "description": "<what to ship in ≤3 sentences>",
      "phase_estimate": "<P11 / P12 / P13 etc — order-of-magnitude effort>",
      "addresses_gaps": ["<gap.name>", ...]
    }
  ],
  "openings": "<≤80 words: what an excellent system on this axis would have that SatRank does NOT have today>",
  "minimum_for_excellence": [
    "<concrete shippable item 1>",
    "<concrete shippable item 2>",
    "..."
  ]
}

Severity scale: 1=minor, 3=blocks some flows, 5=blocks core autonomy.

Be HONEST and SHARP. The founder is paying for depth, not encouragement. List 3-7 gaps. Cite specific systems/endpoints/code paths from the context where relevant. Do not invent capabilities the system doesn't have.`;

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
        // try to extract first {...} block
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

// Aggregate verdicts
const verdictCounts = { READY: 0, GAPS: 0, NOT_READY: 0 };
const allGaps = [];
const allFixes = [];
for (const r of results) {
  const p = r.parsed;
  if (!p) continue;
  verdictCounts[p.verdict] = (verdictCounts[p.verdict] ?? 0) + 1;
  for (const g of (p.gaps ?? [])) allGaps.push({ lens: p.lens_name, ...g });
  for (const f of (p.fixes_to_converge ?? [])) allFixes.push({ lens: p.lens_name, ...f });
}

const md = [
  `# SatRank autonomy audit — ${TAG}`,
  ``,
  `Model: ${MODEL}. ${results.length} lenses. Total in=${results.reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0)} out=${results.reduce((a, r) => a + (r.usage?.output_tokens ?? 0), 0)}.`,
  ``,
  `## Verdict distribution`,
  ``,
  `- READY: ${verdictCounts.READY}`,
  `- GAPS: ${verdictCounts.GAPS}`,
  `- NOT_READY: ${verdictCounts.NOT_READY}`,
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
      `**Gaps (${(p.gaps ?? []).length}):**`,
      ...(p.gaps ?? []).map(g => `- [sev ${g.severity}${g.blocks_autonomy ? ', blocks autonomy' : ''}] **${g.name}** — ${g.scenario}${g.current_workaround ? ` _(workaround: ${g.current_workaround})_` : ''}`),
      ``,
      `**Fixes:**`,
      ...(p.fixes_to_converge ?? []).map(f => `- **${f.name}** (${f.phase_estimate}) — ${f.description}`),
      ``,
      `**Openings:** ${p.openings}`,
      ``,
      `**Minimum for excellence:**`,
      ...(p.minimum_for_excellence ?? []).map(x => `- ${x}`),
      ``,
    ].join('\n');
  }),
  ``,
  `## Cross-lens gap clusters (severity ≥4)`,
  ``,
  ...allGaps.filter(g => g.severity >= 4).sort((a, b) => b.severity - a.severity).map(g => `- [sev ${g.severity}] **${g.name}** _(lens: ${g.lens})_ — ${g.scenario}`),
  ``,
  `## All proposed fixes (across lenses)`,
  ``,
  ...allFixes.map(f => `- **${f.name}** _(${f.lens})_ ${f.phase_estimate ? `[${f.phase_estimate}]` : ''} — ${f.description}`),
  ``,
].join('\n');

const aggPath = path.join(OUT_DIR, 'aggregate.md');
fs.writeFileSync(aggPath, md);
console.log(`Aggregate written to ${aggPath}`);
console.log(`Verdict distribution:`, verdictCounts);
