// SatRank sim aggregator — reads runs/<SIM_RUN>/verdicts.json and emits
// summary.md with the 3-criteria GO/NO-GO matrix, distribution, and pay_2xx %.
//
// Usage:
//   SIM_RUN=sim-N node scripts/sim/aggregate.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runId = process.env.SIM_RUN;
if (!runId) { console.error('SIM_RUN env required'); process.exit(1); }

const runDir = path.join(__dirname, 'runs', runId);
const verdicts = JSON.parse(fs.readFileSync(path.join(runDir, 'verdicts.json'), 'utf8'));

function field(text, name) {
  const re = new RegExp(`${name}:\\s*([^\\n]+)`);
  const m = text?.match(re);
  return m ? m[1].trim() : null;
}
function num(text, name) {
  const v = field(text, name);
  return v ? parseInt(v, 10) : 0;
}

const rows = verdicts.map(r => {
  if (r.error || !r.final_text) {
    return { idx: r.idx, persona: r.persona, status: 'ERROR', error: r.error };
  }
  const text = r.final_text;
  return {
    idx: r.idx,
    persona: r.persona,
    verdict: field(text, 'verdict'),
    accomplish_without: field(text, 'would_have_accomplished_without_satrank'),
    sats_spent: num(text, 'sats_spent_total'),
    attempted: num(text, 'calls_attempted'),
    pay_2xx: num(text, 'calls_pay_2xx'),
    delivery_ok: num(text, 'calls_delivery_ok'),
    body_sha256: field(text, 'body_sha256_observed'),
    synonym: field(text, 'synonym_fallback_observed'),
    improved: field(text, 'visibly_improved_vs_prior_sim'),
    turns: r.turns,
  };
});

const totalAttempted = rows.reduce((s, r) => s + (r.attempted || 0), 0);
const totalPay2xx = rows.reduce((s, r) => s + (r.pay_2xx || 0), 0);
const counts = rows.reduce((acc, r) => { acc[r.verdict] = (acc[r.verdict] || 0) + 1; return acc; }, {});
const noVotes = rows.filter(r => r.accomplish_without === 'no').length;
const indispensable = counts.indispensable || 0;
const pay2xxPct = totalAttempted ? (totalPay2xx * 100 / totalAttempted) : 0;

const goNoGoExcellence = {
  '≥5 indispensable (excellence)': { target: 5, actual: indispensable, met: indispensable >= 5 },
  '≥7 would_not_accomplish=no (excellence)': { target: 7, actual: noVotes, met: noVotes >= 7 },
  'pay_2xx ≥90% (excellence)': { target: 90, actual: pay2xxPct.toFixed(1), met: pay2xxPct >= 90 },
};
const goNoGoBaseline = {
  '≥1 indispensable (Sim 9 baseline)': { target: 1, actual: indispensable, met: indispensable >= 1 },
  '≥3 would_not_accomplish=no (baseline)': { target: 3, actual: noVotes, met: noVotes >= 3 },
  'pay_2xx ≥80% (baseline)': { target: 80, actual: pay2xxPct.toFixed(1), met: pay2xxPct >= 80 },
};

const summary = `# Sim ${process.env.SIM_NUM ?? runId} Aggregate

Run: \`${runId}\` | Generated: ${new Date().toISOString()}

## Distribution
${Object.entries(counts).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

## Per-agent table
| Agent | Verdict | accomplish_without | pay_2xx/attempted | delivery_ok | body_sha256 | synonym | improved | turns |
|-------|---------|---------|---|---|---|---|---|---|
${rows.map(r => r.error
  ? `| ${r.idx} | ERROR | — | — | — | — | — | — | — |`
  : `| ${r.idx} | ${r.verdict} | ${r.accomplish_without} | ${r.pay_2xx}/${r.attempted} | ${r.delivery_ok}/${r.attempted} | ${r.body_sha256} | ${r.synonym} | ${r.improved} | ${r.turns} |`).join('\n')}

## Aggregates
- Total pay_2xx: ${totalPay2xx}/${totalAttempted} = **${pay2xxPct.toFixed(1)}%**
- "no" votes: ${noVotes}/${rows.length}
- "indispensable" verdicts: ${indispensable}/${rows.length}

## GO/NO-GO — Excellence target
${Object.entries(goNoGoExcellence).map(([k, v]) => `- ${v.met ? '✅' : '❌'} ${k}: ${v.actual} / ${v.target}`).join('\n')}

## GO/NO-GO — Baseline (Sim 9 criteria)
${Object.entries(goNoGoBaseline).map(([k, v]) => `- ${v.met ? '✅' : '❌'} ${k}: ${v.actual} / ${v.target}`).join('\n')}
`;

const out = path.join(runDir, 'summary.md');
fs.writeFileSync(out, summary);
console.log(summary);
console.log(`\nSummary → ${out}`);
