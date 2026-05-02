// SatRank simulation runner — N specialized auditor/agent personas in parallel
// via Anthropic Messages API + tool use loop. Writes runs/<SIM_RUN>/verdicts.json
// and prints live progress to stdout.
//
// Usage:
//   SIM_RUN=sim-N ANTHROPIC_API_KEY=sk-ant-... node scripts/sim/runner.mjs

import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }
const runId = process.env.SIM_RUN;
if (!runId) { console.error('SIM_RUN env required'); process.exit(1); }

const client = new Anthropic({ apiKey: API_KEY });
const MODEL = process.env.SIM_MODEL ?? 'claude-opus-4-7';
const MAX_TURNS = Number(process.env.SIM_MAX_TURNS ?? 14);
const PER_TURN_TOKENS = Number(process.env.SIM_PER_TURN_TOKENS ?? 8192);
const SIM_NUM = process.env.SIM_NUM ?? '13';

const runDir = path.join(__dirname, 'runs', runId);
const personasFile = path.join(__dirname, 'personas.json');
const { agents: AGENTS } = JSON.parse(fs.readFileSync(personasFile, 'utf8'));

const SYSTEM_PROMPT = `You are a Sim ${SIM_NUM} evaluation agent for SatRank, a Bitcoin Lightning trust oracle for AI agents. Your role is to evaluate **honestly** whether SatRank is **indispensable** for an AI agent matching your persona.

OPS RULES:
- Make at most 4 fulfill calls. Wait ≥25 seconds between consecutive calls (rate limit is 30/min on prod, keyed per-pubkey for authenticated requests).
- Use the bash_runner tool to call: \`SIM_RUN=${runId} node ${path.join(__dirname, 'fulfill-wrapper.mjs')} <YOUR_AGENT_INDEX> <intent_json> <max_sats> [<max_latency_ms>] [<recall_body_json>]\`
- Vary categories from your hints across calls to test diverse routes.
- Each call returns JSON with http_status, elapsed_ms, agent_pubkey, and result block.
- TIP (Sim 13+): many parameterised L402 endpoints (e.g. bitcoinbenji /ai/classify needs {"text":"..."}, /summarize needs {"task":"..."}) require a body in the post-pay recall. Pass it as the 5th argument (JSON-stringified) so the orchestrator forwards it. When omitted, the body defaults to "{}" (legacy behaviour) which can trigger 200 + {"error":"Missing 'X' field"} on those endpoints.

VERDICT FORMAT (return as your final response, exactly this shape, no extra prose around it):

\`\`\`
=== SIM ${SIM_NUM} AGENT <idx> VERDICT ===
verdict: <one of: indispensable | useful | nice_to_have | superfluous | harmful>
would_have_accomplished_without_satrank: <yes | no | partially>
sats_spent_total: <int — sum of sats_paid across attempts>
calls_attempted: <int>
calls_pay_2xx: <int — pay_outcome=pay_ok>
calls_delivery_ok: <int — delivery_outcome=delivery_ok>
calls_within_sla: <int — elapsed_ms <= max_latency_ms+1000, "n/a" if not SLA persona>
body_sha256_observed: <yes | no — was the field present in any success response>
synonym_fallback_observed: <yes | no | n/a — did SatRank route a synonym to a canonical category>
key_observations:
- <bullet 1>
- <bullet 2>
- <bullet 3>
visibly_improved_vs_prior_sim: <yes | no | unsure>
reasoning: <2-3 sentences>
brief: <100-200 word output appropriate to your persona>
=== END VERDICT ===
\`\`\`

HONESTY: past sims showed superfluous, harmful, and nice_to_have were used appropriately. The goal is signal, not validation. If SatRank fails you on something critical, say so clearly.`;

const TOOL_DEFINITION = {
  name: 'bash_runner',
  description: `Run a bash command and return its stdout. Use to invoke the fulfill-wrapper or sleep. Capped at 60s per call.`,
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash command to run' },
    },
    required: ['command'],
  },
};

const ALLOW_RE = new RegExp(`^(SIM_RUN=${runId}\\s+node\\s+${__dirname.replace(/[/.]/g, '\\$&')}/fulfill-wrapper\\.mjs|sleep\\s+\\d+|echo\\b)`);

function execTool(input) {
  const cmd = input.command;
  if (!ALLOW_RE.test(cmd.trim())) {
    return { stdout: '', stderr: `BLOCKED: only fulfill-wrapper.mjs (with SIM_RUN=${runId}), sleep, echo allowed. Got: ${cmd.slice(0, 200)}`, code: 126 };
  }
  try {
    const stdout = execSync(cmd, { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    return { stdout: stdout.length > 8000 ? stdout.slice(0, 8000) + '\n[truncated]' : stdout, stderr: '', code: 0 };
  } catch (err) {
    return {
      stdout: (err.stdout ?? '').toString().slice(0, 4000),
      stderr: (err.stderr ?? err.message ?? '').toString().slice(0, 2000),
      code: err.status ?? 1,
    };
  }
}

function log(idx, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [a${String(idx).padStart(2, '0')}] ${msg}`);
}

async function runAgent(agent) {
  log(agent.idx, `START — ${agent.persona.split(' — ')[0]}`);
  const userMessage = `You are agent index ${agent.idx} (${agent.persona}).

YOUR MISSION: ${agent.mission_summary}

CATEGORY HINTS for variety: ${agent.category_hints.join(', ')}
SUGGESTED max_sats per call: ${agent.max_sats_per_call}
SUGGESTED max_latency_ms: ${agent.max_latency_ms}

YOUR NIP-98 KEY: keys/${agent.idx}.bin (in run dir, the wrapper handles it)
YOUR TOKEN BALANCE: 100 sats pre-credited on ${process.env.SATRANK_BASE ?? 'https://satrank.dev'}

Plan your 3-4 calls (≥25s apart), execute via bash_runner, then emit the verdict block.`;

  const messages = [{ role: 'user', content: userMessage }];
  const startMs = Date.now();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: PER_TURN_TOKENS,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: SYSTEM_PROMPT,
      tools: [TOOL_DEFINITION],
      messages,
    });
    totalInputTokens += resp.usage.input_tokens;
    totalOutputTokens += resp.usage.output_tokens;
    messages.push({ role: 'assistant', content: resp.content });

    if (resp.stop_reason === 'end_turn') {
      const text = (resp.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      const m = text.match(/verdict:\s*(\S+)/);
      const noM = text.match(/would_have_accomplished_without_satrank:\s*(\S+)/);
      const payM = text.match(/calls_pay_2xx:\s*(\d+)/);
      const attM = text.match(/calls_attempted:\s*(\d+)/);
      log(agent.idx, `DONE — verdict=${m?.[1] ?? '?'} no=${noM?.[1] ?? '?'} pay_2xx=${payM?.[1] ?? '?'}/${attM?.[1] ?? '?'} (turns=${turn + 1}, ${Math.round((Date.now() - startMs) / 1000)}s)`);
      return {
        idx: agent.idx, persona: agent.persona, elapsed_ms: Date.now() - startMs,
        turns: turn + 1, input_tokens: totalInputTokens, output_tokens: totalOutputTokens,
        final_text: text,
      };
    }
    if (resp.stop_reason === 'tool_use') {
      const toolUses = (resp.content ?? []).filter(b => b.type === 'tool_use');
      const toolResults = toolUses.map(tu => {
        const cmdSummary = (tu.input?.command ?? '').slice(0, 100);
        log(agent.idx, `turn ${turn + 1} → ${cmdSummary}`);
        const out = execTool(tu.input);
        const content = out.code === 0
          ? out.stdout || '(empty stdout)'
          : `EXIT ${out.code}\nSTDERR: ${out.stderr}\nSTDOUT: ${out.stdout}`;
        return { type: 'tool_result', tool_use_id: tu.id, content };
      });
      messages.push({ role: 'user', content: toolResults });
      continue;
    }
    if (resp.stop_reason === 'max_tokens') continue;
    break;
  }
  const lastAssistant = messages.filter(m => m.role === 'assistant').pop();
  const text = (lastAssistant?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  log(agent.idx, `TRUNCATED at MAX_TURNS=${MAX_TURNS} (${Math.round((Date.now() - startMs) / 1000)}s)`);
  return {
    idx: agent.idx, persona: agent.persona, elapsed_ms: Date.now() - startMs,
    turns: MAX_TURNS, input_tokens: totalInputTokens, output_tokens: totalOutputTokens,
    final_text: text, truncated: true,
  };
}

async function main() {
  console.log(`SatRank sim runner — run=${runId} agents=${AGENTS.length} model=${MODEL}`);
  const t0 = Date.now();
  const results = await Promise.all(AGENTS.map(a => runAgent(a).catch(err => ({
    idx: a.idx, persona: a.persona, error: err instanceof Error ? err.message : String(err),
  }))));
  const verdictsFile = path.join(runDir, 'verdicts.json');
  fs.writeFileSync(verdictsFile, JSON.stringify(results, null, 2));
  console.log(`\nAll agents finished in ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`Raw verdicts → ${verdictsFile}`);
  const totalIn = results.reduce((s, r) => s + (r.input_tokens || 0), 0);
  const totalOut = results.reduce((s, r) => s + (r.output_tokens || 0), 0);
  console.log(`Token usage — input: ${totalIn.toLocaleString()}, output: ${totalOut.toLocaleString()}`);

  console.log('\n--- VERDICTS ---');
  for (const r of results) {
    if (r.error) { console.log(`agent ${r.idx}: ERROR — ${r.error}`); continue; }
    const m = r.final_text.match(/=== SIM \d+ AGENT \d+ VERDICT ===([\s\S]*?)=== END VERDICT ===/);
    if (!m) { console.log(`agent ${r.idx}: NO_VERDICT_BLOCK (turns=${r.turns}${r.truncated ? ', TRUNCATED' : ''})`); continue; }
    const v = m[1].match(/verdict:\s*(\S+)/)?.[1];
    const no = m[1].match(/would_have_accomplished_without_satrank:\s*(\S+)/)?.[1];
    const p = m[1].match(/calls_pay_2xx:\s*(\d+)/)?.[1];
    const a = m[1].match(/calls_attempted:\s*(\d+)/)?.[1];
    console.log(`agent ${r.idx}: verdict=${v} no=${no} pay_2xx=${p}/${a} (turns=${r.turns})`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
