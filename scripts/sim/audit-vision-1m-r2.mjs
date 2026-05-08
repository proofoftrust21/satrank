// SatRank — round 2 brainstorm visionnaire : head-to-head 3 finalistes
// SlashPoint vs Hayek Window vs Witness Market — convergence vers 1 seule idée

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }
const MODEL = 'claude-opus-4-7';
const TAG = `${new Date().toISOString().slice(0,10).replace(/-/g,'')}-vis1m-r2`;
const OUT_DIR = path.join(__dirname, 'runs', `audit-vision-1m-${TAG}`);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'raw'), { recursive: true });

const lensesPath = path.join(__dirname, 'audit-converge-lenses.json');
const { lenses } = JSON.parse(fs.readFileSync(lensesPath, 'utf8'));

// Load the 3 finalists from round 1
const r1Dir = path.join(__dirname, 'runs', 'audit-vision-1m-20260508-vis1m-r1', 'raw');
const slashPoint = fs.readFileSync(path.join(r1Dir, 'phase_a_A4_architecte_solo_dev.md'), 'utf8');
const hayekWindow = fs.readFileSync(path.join(r1Dir, 'phase_a_A3_economiste_hayekien.md'), 'utf8');
const witnessMarket = fs.readFileSync(path.join(r1Dir, 'phase_a_A5_bitcoin_maximaliste.md'), 'utf8');

const client = new Anthropic({ apiKey: API_KEY });

const COMMON_CONTEXT = `# Audit visionnaire — round 2 head-to-head 3 finalistes

Round 1 brainstorm a produit 7 killer ideas + 7/7 bets 100k sats personnels, mais répartis sur 3 finalistes :
- **SlashPoint — Nonce-Pinning Registry** (3 votes)
- **Hayek Window — discount window agentique** (2 votes)
- **Witness Market — PTLC-ZKCP relay** (2 votes)

Round 2 = **head-to-head** : tu choisis LE seul winner que tu veux que Romain ship.

## Cadre rappel

- 1M+ sats/jour revenu SatRank à maturité 2027-2030
- Bitcoin-pur strict, doctrine immuable
- Solo dev Romain en 30-90j max
- Indispensable par construction OU effet réseau cumulatif non-DIY

## Les 3 finalistes — specs ultra-détaillées

### FINALISTE 1 — SlashPoint (origine: Architecte solo dev)

${slashPoint}

---

### FINALISTE 2 — Hayek Window (origine: Économiste hayekien)

${hayekWindow}

---

### FINALISTE 3 — Witness Market (origine: Bitcoin maximaliste)

${witnessMarket}

---

## Ta mission round 2

**Choisis 1 seule** des 3 finalistes que tu veux que Romain ship. Sois adversarial sur les 2 autres — pourquoi tu refuses qu'il les ship.

## Format strict (parsé automatiquement)

\`\`\`
SCORES_3_FINALISTS:
  SlashPoint: indisp=<n>/10 doctrine=<n>/10 ship=<n>/10 revenue=<n>/10 vision=<n>/10
  HayekWindow: indisp=<n>/10 doctrine=<n>/10 ship=<n>/10 revenue=<n>/10 vision=<n>/10
  WitnessMarket: indisp=<n>/10 doctrine=<n>/10 ship=<n>/10 revenue=<n>/10 vision=<n>/10

THE_ONE: <SlashPoint | HayekWindow | WitnessMarket>

WHY_THE_ONE: <100-150 mots — pourquoi cette idée bat les 2 autres définitivement>

WHY_NOT_OTHER_1: <le finalist non-choisi #1, en 50-80 mots de pourquoi tu refuses>
WHY_NOT_OTHER_2: <l'autre finalist non-choisi, en 50-80 mots>

BET_100K_SATS_ON_THE_ONE: <oui | non>
WHY_BET: <1-3 phrases>

KILL_BLOCKER_REMAINING: <si NON, quelle modification minimale ferait passer à OUI ; si OUI, "aucun, ship tel quel">

LIFETIME_REVENUE_2030_PROJECTION: <tes sats/jour estimés sur THE_ONE à maturité 2030>
\`\`\`

Aucun préambule, aucune politesse, tu es decider, sois sec et tranchant.

## Ton angle métier`;

async function evalPhase(lens) {
  const userPrompt = `${COMMON_CONTEXT}\n\n**Tu es : ${lens.name}**\n\n${lens.role}\n\nChoisis LE seul finalist maintenant.`;
  const startedAt = Date.now();
  let resp;
  try {
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (e) {
    return { lens_id: lens.id, error: e.message, raw: '' };
  }
  const elapsed = Date.now() - startedAt;
  const raw = (resp.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'raw', `phase_b_${lens.id}.md`), raw);

  const theOneMatch = raw.match(/THE_ONE:\s*(SlashPoint|HayekWindow|WitnessMarket)/i);
  const betMatch = raw.match(/BET_100K_SATS_ON_THE_ONE:\s*(oui|non)/i);
  const whyMatch = raw.match(/WHY_THE_ONE:\s*(.+?)(?=\n[A-Z_]+:|$)/is);
  const blockerMatch = raw.match(/KILL_BLOCKER_REMAINING:\s*(.+?)(?=\n[A-Z_]+:|$)/is);
  const revenueMatch = raw.match(/LIFETIME_REVENUE_2030_PROJECTION:\s*(.+?)(?=\n[A-Z_]+:|$)/is);

  console.log(`[R2] ✓ ${lens.id} — THE_ONE=${theOneMatch?.[1] || '?'} bet=${betMatch?.[1] || '?'} ${(elapsed/1000).toFixed(1)}s`);

  return {
    lens_id: lens.id,
    lens_name: lens.name,
    raw,
    the_one: theOneMatch?.[1],
    bet: betMatch?.[1]?.toLowerCase(),
    why_the_one: whyMatch?.[1].trim(),
    blocker: blockerMatch?.[1].trim(),
    revenue_2030: revenueMatch?.[1].trim(),
    usage: resp.usage,
    elapsed_ms: elapsed,
  };
}

console.log(`\n=== Round 2 — head-to-head 3 finalistes ===\n`);
const results = await Promise.all(lenses.map(evalPhase));

const totalIn = results.reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0);
const totalOut = results.reduce((a, r) => a + (r.usage?.output_tokens ?? 0), 0);

const counts = { SlashPoint: 0, HayekWindow: 0, WitnessMarket: 0 };
for (const r of results) {
  if (r.the_one) counts[r.the_one] = (counts[r.the_one] || 0) + 1;
}

const winner = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
const betsOuiOnWinner = results.filter(r => r.the_one === winner[0] && r.bet === 'oui').length;

const md = [
  `# SatRank — round 2 head-to-head 3 finalistes`,
  ``,
  `Model: ${MODEL} | thinking: adaptive | 7 agents.`,
  `Tokens : in=${totalIn} out=${totalOut} | coût ≈ $${((totalIn * 15 + totalOut * 75) / 1e6).toFixed(2)}.`,
  ``,
  `## Vote distribution`,
  ``,
  `- **SlashPoint** : ${counts.SlashPoint} / 7 votes`,
  `- **HayekWindow** : ${counts.HayekWindow} / 7 votes`,
  `- **WitnessMarket** : ${counts.WitnessMarket} / 7 votes`,
  ``,
  `**WINNER : ${winner[0]} (${winner[1]} votes)**`,
  `**Bets OUI sur le winner : ${betsOuiOnWinner} / ${winner[1]}**`,
  ``,
  `${winner[1] === 7 ? '✅ CONSENSUS UNANIME — tous les 7 agents convergent sur la même idée' : winner[1] >= 5 ? '🟡 majorité forte (≥5/7) sur ' + winner[0] : '❌ pas de consensus, distribution éclatée'}`,
  ``,
  `## Tableau des votes`,
  ``,
  `| Agent | THE_ONE | Bet 100k sats | Revenue 2030 (sats/jour) |`,
  `|---|---|---|---|`,
  ...results.map(r => `| ${r.lens_name} | **${r.the_one || '?'}** | ${r.bet || '?'} | ${r.revenue_2030 || '?'} |`),
  ``,
  `## Détail par agent`,
  ``,
  ...results.map(r => [
    `### ${r.lens_id} — ${r.lens_name}`,
    ``,
    `**THE_ONE** : ${r.the_one || '?'}`,
    ``,
    `**WHY** : ${r.why_the_one || '?'}`,
    ``,
    `**Bet 100k sats** : ${r.bet || '?'}`,
    ``,
    `**Kill blocker** : ${r.blocker || '?'}`,
    ``,
    `**Revenue 2030 estimé** : ${r.revenue_2030 || '?'}`,
    ``,
    `Voir \`raw/phase_b_${r.lens_id}.md\` pour détail complet.`,
    ``,
    `---`,
    ``,
  ].join('\n')),
].join('\n');

fs.writeFileSync(path.join(OUT_DIR, 'AUDIT.md'), md);
console.log(`\n=== Audit complet : ${path.join(OUT_DIR, 'AUDIT.md')} ===`);
console.log(`Coût total : ~$${((totalIn * 15 + totalOut * 75) / 1e6).toFixed(2)}`);
console.log(`Distribution : SlashPoint=${counts.SlashPoint} HayekWindow=${counts.HayekWindow} WitnessMarket=${counts.WitnessMarket}`);
console.log(`Winner: ${winner[0]} (${winner[1]} votes), bets OUI: ${betsOuiOnWinner}/${winner[1]}`);
