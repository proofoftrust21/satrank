// SatRank — audit brainstorm itératif round 2.
// Donne aux 7 agents le résultat du round 1 + le feedback de l'audit round 11.
// Demande : raffinement des idées top-convergentes pour résoudre les blockers.
// Phase A : raffinement parallèle (4 variantes par agent).
// Phase B : revote sur le pool combiné (nouveau).

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }
const MODEL = 'claude-opus-4-7';
const TAG = `${new Date().toISOString().slice(0,10).replace(/-/g,'')}-bs2`;
const OUT_DIR = path.join(__dirname, 'runs', `audit-brainstorm-${TAG}`);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'raw'), { recursive: true });

const lensesPath = path.join(__dirname, 'audit-converge-lenses.json');
const { lenses } = JSON.parse(fs.readFileSync(lensesPath, 'utf8'));

// Read the previous brainstorm output to seed
const prevPool = fs.readFileSync(path.join(__dirname, 'runs', 'audit-brainstorm-20260508-bs1', 'pool_ideas.md'), 'utf8');

const client = new Anthropic({ apiKey: API_KEY });

const COMMON_CONTEXT = `# Audit brainstorm itératif — round 2

Tu es l'un de 7 agents Opus 4.7 indépendants. Round 1 brainstorm a produit 28 idées. La convergence a émergé sur **Adversarial Liveness Beacon** (TOP_1 chez 4/7 agents) et **Equivocation Bond Pool** (CONSENSUS chez 3/7). Une spec V1.0 fusionnant les deux a été testée au round audit 11.

## Résultat round audit 11 sur spec Liveness V1.0

**0/7 SPEC_VALIDE / 1/7 INDISPENSABLE.** Les 7 agents ont convergé sur LE MÊME blocker structurel :

> SatRank devient un **orchestrateur centralisé / oracle / tribunal** déguisé en protocole cypherpunk. Spécifiquement :
> 1. SatRank émet les challenges → peut censurer ou fabriquer
> 2. SatRank juge le "no_response" → tribunal de facto
> 3. SatRank co-signe la TX de slashing → contrôle qui slash et quand
> 4. Le \`H(target_secret || nonce || ts)\` est cryptographiquement invérifiable car SatRank ne connaît pas \`target_secret\`

Plus, plusieurs alternatives DIY ont été pointées :
- Cypherpunk : "HTLC probe direct A→B + hold-invoice native suffisent"
- Hayek : "Séquence micro-probes échelonnés 1k→10k→100k sats fournit la même découverte"
- Architecte solo : "Challenge-response Schnorr peer-to-peer en 50 LOC"
- Agent 2030 : "Atomicité HTLC suffit pour 99% des transactions"

## Cadre — économie agentique Bitcoin 2030+

Bitcoin a gagné par défaut. Doctrine cypherpunk : math protects, code is law, no trusted intermediaries, sans permission. **Aucun tribunal humain, aucun comité d'oracle.**

## Doctrine immuable du founder

- ✗ x402, USDC, EVM, BIP submission, compliance, KYC, AML
- ✗ Partenariats Lightning Labs / Anthropic / Coinbase
- ✗ **Tribunal humain ou comité d'oracle (rejet absolu)**
- ✗ Cohabitation V1/V2
- ✓ Solo dev + Bitcoin-pur strict + open-source MIT/0BSD
- ✓ Privacy-by-default

## Pool de 28 idées brainstormées au round 1

${prevPool}

## Ta mission round 2

Tu vas brainstormer **4 variantes RAFFINÉES** qui :

1. **Résolvent explicitement le blocker round 11** (pas de tribunal/oracle SatRank). Le slashing ou la décision doit être 100% mécanique cryptographique, vérifiable par n'importe qui, sans aucune signature SatRank dans la boucle critique.

2. **Restent indispensables vs DIY** — si l'agent peut faire la même chose avec HTLC probe direct + hold-invoice + Nostr DM, ce n'est pas indispensable. Trouve l'asymétrie irréductible (capital pool, network effect cryptographique, primitive non-reproductible).

3. **Combinent les meilleurs éléments** des idées du pool round 1 (tu peux fusionner, pas juste raffiner une seule).

4. **Sont VRAIMENT cypherpunk** — math protects, code is law, no trusted middleman.

Pense différent : si la "Liveness Beacon" classique tombe dans le piège tribunal, peut-être qu'elle doit être **inversée** (l'agent prouve sa propre liveness sans demande tierce, par publication continue d'un signal anchored), ou **distribuée** (N challengers indépendants où aucun ne peut censurer seul), ou **embarquée dans le bond** (le bond auto-burn mécanique sans signature SatRank), ou autre.

Sois CRÉATIF. Pas un V1.1 timide — une **vraie variante structurelle** qui résout le tribunal-trap.

## Format de sortie OBLIGATOIRE

\`\`\`
IDEA_1:
  name: <nom court>
  one_line: <1 phrase>
  job_to_be_done: <quel job concret d'agent 2030>
  primitive: <crypto Bitcoin-pure précise>
  fix_blocker_round_11: <comment ça résout le piège tribunal/oracle de R11>
  why_not_DIY: <pourquoi indispensable vs HTLC probe + hold-invoice + Nostr>
  pricing: <X sats/unité>
  volume_2030_per_day: <estimation>
  doctrine_alignment: <oui/non + raison>

IDEA_2: ...
IDEA_3: ...
IDEA_4: ...
\`\`\`

Aucun préambule, format strict.

## Ton angle métier`;

async function brainstormPhase(lens) {
  const userPrompt = `${COMMON_CONTEXT}\n\n**Tu es : ${lens.name}**\n\n${lens.role}\n\nMaintenant brainstorm 4 variantes RAFFINÉES qui résolvent le blocker R11.`;
  const startedAt = Date.now();
  let resp;
  try {
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: 6000,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (e) {
    return { lens_id: lens.id, error: e.message, raw: '' };
  }
  const elapsed = Date.now() - startedAt;
  const raw = (resp.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'raw', `phase_a_${lens.id}.md`), raw);
  console.log(`[A] ✓ ${lens.id} — ${(elapsed / 1000).toFixed(1)}s — ${raw.length}c`);
  return { lens_id: lens.id, lens_name: lens.name, raw, usage: resp.usage, elapsed_ms: elapsed };
}

console.log(`\n=== Phase A — Brainstorm itératif raffiné (7 agents × 4 variantes) ===\n`);
const phaseAResults = await Promise.all(lenses.map(brainstormPhase));

let poolText = '';
let totalIdeas = 0;
for (const r of phaseAResults) {
  if (r.error) continue;
  poolText += `\n## Variantes raffinées de ${r.lens_name}\n\n${r.raw}\n`;
  const matches = (r.raw.match(/^IDEA_\d+:/gm) || []).length;
  totalIdeas += matches;
}
fs.writeFileSync(path.join(OUT_DIR, 'pool_variants.md'), poolText);
console.log(`\n${totalIdeas} variantes raffinées au total.\n`);

const EVAL_CONTEXT = `# Audit brainstorm itératif round 2 — Phase B

Évalue le **nouveau pool** de variantes raffinées issu de Phase A.

## Cadre rappel

Bitcoin-pur strict. Pas de tribunal. Pas de comité d'oracle. Solo dev. Open-source MIT.

Le blocker du round 11 était : **SatRank devient orchestrateur/oracle/tribunal centralisé**. Toute idée qui réintroduit ce piège est rejetée.

## Pool des ${totalIdeas} variantes raffinées (Phase A round 2)

${poolText}

## Ta mission Phase B

Pour CHAQUE variante du pool, donne :
- Note **fix_tribunal** 0-10 (10 = aucun tribunal SatRank, 0 = tribunal masqué)
- Note **indispensabilité** 0-10 (10 = sans cette primitive l'agent ne peut PAS faire son job, 0 = DIY suffit)
- Note **doctrine_fit** 0-10

Puis identifie :
- **TOP_1** : ta variante préférée du pool (peut être la tienne ou d'un autre)
- **WHY_TOP_1** : 2-3 phrases sur pourquoi celle-ci résout VRAIMENT le tribunal-trap ET reste indispensable
- **CONSENSUS_CANDIDATE** : si tu vois UNE variante que TOUS les angles devraient juger indispensable, laquelle ? (ou "aucune")
- **READY_TO_VOTE_INDISPENSABLE** : oui/non — si on faisait un round audit-converge sur le TOP_1, voterais-tu INDISPENSABLE=OUI ?

## Format strict

\`\`\`
EVAL_${`<lens_id>`}:
  IDEA_1_AGENT_<n> fix_tribunal=<n>/10 indispensabilité=<n>/10 doctrine=<n>/10
  ... pour les ${totalIdeas} variantes

TOP_1: <référence claire>
WHY_TOP_1: <2-3 phrases>
CONSENSUS_CANDIDATE: <référence ou "aucune">
WHY_CONSENSUS: <2-3 phrases ou "n/a">
READY_TO_VOTE_INDISPENSABLE: oui/non
WHY_READY: <1 phrase>
\`\`\`

## Ton angle métier`;

async function evalPhase(lens) {
  const userPrompt = `${EVAL_CONTEXT}\n\n**Tu es : ${lens.name}**\n\n${lens.role}\n\nÉvalue le pool des variantes raffinées.`;
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

  const top1 = raw.match(/TOP_1:\s*(.+?)(?=\n[A-Z_]+:|$)/is);
  const consensus = raw.match(/CONSENSUS_CANDIDATE:\s*(.+?)(?=\n[A-Z_]+:|$)/is);
  const ready = raw.match(/READY_TO_VOTE_INDISPENSABLE:\s*(oui|non)/i);
  const whyReady = raw.match(/WHY_READY:\s*(.+?)(?=\n[A-Z_]+:|$)/is);

  console.log(`[B] ✓ ${lens.id} — top1: ${(top1?.[1] || '?').slice(0, 50)} — ready=${ready?.[1] || '?'}`);
  return {
    lens_id: lens.id,
    lens_name: lens.name,
    raw,
    top1: top1?.[1].trim(),
    consensus_candidate: consensus?.[1].trim(),
    ready_to_vote: ready?.[1].toLowerCase(),
    why_ready: whyReady?.[1].trim(),
    usage: resp.usage,
    elapsed_ms: elapsed,
  };
}

console.log(`\n=== Phase B — Revote du pool raffiné ===\n`);
const phaseBResults = await Promise.all(lenses.map(evalPhase));

const totalIn = [...phaseAResults, ...phaseBResults].reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0);
const totalOut = [...phaseAResults, ...phaseBResults].reduce((a, r) => a + (r.usage?.output_tokens ?? 0), 0);
const readyOuis = phaseBResults.filter(r => r.ready_to_vote === 'oui').length;

const md = [
  `# SatRank — audit brainstorm round 2 (itératif post-R11)`,
  ``,
  `Model: ${MODEL} | thinking: adaptive | 7 agents × 2 phases.`,
  `Tokens : in=${totalIn} out=${totalOut} | coût ≈ $${((totalIn * 15 + totalOut * 75) / 1e6).toFixed(2)}.`,
  `${totalIdeas} variantes raffinées générées.`,
  ``,
  `## READY_TO_VOTE_INDISPENSABLE : ${readyOuis} / 7`,
  ``,
  `${readyOuis === 7 ? '✅ CONSENSUS — tous prêts à voter INDISPENSABLE sur leur top pick' : '❌ pas encore consensus — itérer'}`,
  ``,
  `## Tableau des votes Phase B`,
  ``,
  `| Agent | TOP_1 | CONSENSUS_CANDIDATE | READY |`,
  `|---|---|---|---|`,
  ...phaseBResults.map(r => `| ${r.lens_name} | ${(r.top1 || '?').slice(0, 80)} | ${(r.consensus_candidate || '?').slice(0, 60)} | ${r.ready_to_vote || '?'} |`),
  ``,
  `## Détail Phase B`,
  ``,
  ...phaseBResults.map(r => [
    `### ${r.lens_id} — ${r.lens_name}`,
    ``,
    `**TOP_1** : ${r.top1 || '?'}`,
    ``,
    `**CONSENSUS_CANDIDATE** : ${r.consensus_candidate || '?'}`,
    ``,
    `**READY_TO_VOTE** : ${r.ready_to_vote || '?'} — ${r.why_ready || '?'}`,
    ``,
    `Voir \`raw/phase_b_${r.lens_id}.md\` pour détails complets.`,
    ``,
    `---`,
    ``,
  ].join('\n')),
].join('\n');

fs.writeFileSync(path.join(OUT_DIR, 'AUDIT.md'), md);
console.log(`\n=== Audit complet : ${path.join(OUT_DIR, 'AUDIT.md')} ===`);
console.log(`Coût total : ~$${((totalIn * 15 + totalOut * 75) / 1e6).toFixed(2)}`);
console.log(`READY_TO_VOTE_INDISPENSABLE : ${readyOuis} / 7`);
