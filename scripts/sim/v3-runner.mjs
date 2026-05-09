// SatRank V3 simulation runner.
//
// Spawns N agent personas in parallel. Each calls /api/intent (paid 2 sats
// via L402 — invoice paid by us through prod LND self-payment) and reasons
// about the catalog quality. Final verdict is one of indispensable / useful
// / nice_to_have / superfluous / harmful.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... SIM_RUN=v3-sim-1 node scripts/sim/v3-runner.mjs
//
// Optional env:
//   SIM_PERSONAS  - path to personas JSON (default scripts/sim/personas-v3.json)
//   SIM_MAX_TURNS - tool-use turns per agent (default 8)
//   SIM_MODEL     - claude model (default claude-opus-4-7)

import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }
const runId = process.env.SIM_RUN ?? `v3-sim-${Date.now()}`;
const MODEL = process.env.SIM_MODEL ?? 'claude-opus-4-7';
const MAX_TURNS = Number(process.env.SIM_MAX_TURNS ?? 8);
const PER_TURN_TOKENS = 4096;

const personasFile = path.join(__dirname, process.env.SIM_PERSONAS ?? 'personas-v3.json');
const { agents: AGENTS } = JSON.parse(fs.readFileSync(personasFile, 'utf8'));
const runDir = path.join(__dirname, 'runs', runId);
fs.mkdirSync(runDir, { recursive: true });
console.log(`[${runId}] ${AGENTS.length} personas, model=${MODEL}, max_turns=${MAX_TURNS}`);

const client = new Anthropic({ apiKey: API_KEY });

const SYSTEM_PROMPT = (agent) => `You are an evaluation agent for SatRank V3, a Lightning trust oracle for AI agents.
Your role is to evaluate **honestly** whether SatRank V3 is **useful** for an AI agent matching your persona.

YOUR PERSONA:
${agent.persona}

YOUR MISSION:
${agent.mission_summary}

OPS RULES:
- You have ONE tool: \`call_intent\`. Each call costs 2 sats (already paid for you via the operator's LND).
- Make 2 to 4 calls total — vary categories, budgets, and optimize axes from your hints.
- Each call returns the L402 catalog ranking with Bayesian per-stage posteriors.
- Wait at least 25s between consecutive calls (server rate-limits 30/min).

WHAT V3 DOES (relevant for your verdict):
- Crawls L402 endpoints from l402.directory + DNS, probes them, maintains Beta(α,β) posteriors per (endpoint, stage).
- POST /api/intent: paid 2 sats, returns ranked candidates filtered by your category/budget/SLA.
- Bayesian decomposition: 5 stages (challenge, invoice, payment, delivery, quality). p_e2e = product.
- This V3 catalog is FRESH: ~18 endpoints, 1 hour of probe history, n_obs=1 per endpoint typically. \`is_meaningful=false\` is expected for now.
- **CATALOG STATE TODAY**: only the \`data\` category currently has endpoints (18). Calling other categories (\`ai\`, \`bitcoin\`, \`data/finance\`, \`finance\`, etc.) returns zero candidates — that's a real V3 limitation, not a sim error. Use \`data\` for any successful call ; report empty results honestly when you query other categories.

VERDICT FORMAT (return as your final response, exactly this shape):

\`\`\`
=== V3 SIM AGENT ${agent.idx} VERDICT ===
verdict: <one of: indispensable | useful | nice_to_have | superfluous | harmful>
would_have_accomplished_without_satrank: <yes | no | partially>
sats_spent_total: <int — usually 2 × calls>
calls_attempted: <int>
calls_returned_candidates: <int — 200 OK with ≥1 candidate>
catalog_coverage_for_my_mission: <good | partial | poor>
ranking_quality_signal: <good | partial | poor — based on p_e2e / n_obs / latency consistency>
reasoning: <2-3 sentences explaining your verdict>
top_friction_or_blocker: <one short sentence — what was the worst part of using V3?>
top_strength: <one short sentence — what worked best?>
\`\`\``;

const tools = [
  {
    name: 'call_intent',
    description: 'Call POST /api/intent on satrank.dev. Pays 2 sats via L402 (operator-funded). Returns ranked candidates.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'e.g. "data", "data/finance", "ai", "bitcoin"' },
        budget_sats: { type: 'number', minimum: 1, maximum: 1000 },
        max_latency_ms: { type: 'number', minimum: 1000, maximum: 30000 },
        optimize: { type: 'string', enum: ['p_success', 'latency', 'cost'] },
        limit: { type: 'number', minimum: 1, maximum: 10 },
      },
      required: ['category'],
    },
  },
];

function runWrapper(intent) {
  const cmd = `node ${path.join(__dirname, 'v3-intent-wrapper.mjs')} '${JSON.stringify(intent).replace(/'/g, "'\\''")}'`;
  try {
    const stdout = execSync(cmd, { encoding: 'utf8', timeout: 60_000 });
    return stdout.trim();
  } catch (e) {
    return JSON.stringify({ error: 'wrapper failed', message: e.message });
  }
}

async function evaluateAgent(agent) {
  console.log(`[agent ${agent.idx}] starting`);
  const messages = [{
    role: 'user',
    content: `Evaluate SatRank V3 for your persona. Make 2-4 \`call_intent\` calls, then return your verdict in the prescribed format.`,
  }];
  let lastTextOutput = null;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let resp;
    try {
      resp = await client.messages.create({
        model: MODEL,
        max_tokens: PER_TURN_TOKENS,
        system: SYSTEM_PROMPT(agent),
        tools,
        messages,
      });
    } catch (e) {
      console.error(`[agent ${agent.idx}] anthropic API err: ${e.message}`);
      return { idx: agent.idx, error: e.message };
    }
    messages.push({ role: 'assistant', content: resp.content });
    const textBlocks = resp.content.filter((b) => b.type === 'text');
    if (textBlocks.length > 0) lastTextOutput = textBlocks.map((b) => b.text).join('\n');

    if (resp.stop_reason !== 'tool_use') {
      console.log(`[agent ${agent.idx}] done after ${turn + 1} turns (stop_reason=${resp.stop_reason})`);
      break;
    }
    const toolUses = resp.content.filter((b) => b.type === 'tool_use');
    const toolResults = [];
    for (const tu of toolUses) {
      console.log(`[agent ${agent.idx}] turn ${turn + 1}: call_intent ${JSON.stringify(tu.input)}`);
      const out = runWrapper(tu.input);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  return { idx: agent.idx, persona: agent.persona, output: lastTextOutput ?? '<no final text>' };
}

// Serial execution to avoid colliding with the per-IP /api/intent rate limit
// (30/min). Parallel agents from the same source IP burst past it.
const verdicts = [];
for (const a of AGENTS) {
  verdicts.push(await evaluateAgent(a));
}
const out = path.join(runDir, 'verdicts.json');
fs.writeFileSync(out, JSON.stringify(verdicts, null, 2));
console.log(`\n=== ${verdicts.length} verdicts written to ${out} ===\n`);
for (const v of verdicts) {
  console.log(`\n--- Agent ${v.idx} (${v.persona ?? 'err'}) ---`);
  console.log(v.output ?? v.error);
}
