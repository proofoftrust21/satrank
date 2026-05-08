// SatRank — audit de brainstorm collaboratif.
// Phase A : chaque agent propose N idées originales (son angle métier).
// Phase B : chaque agent évalue le pool combiné.
// Phase C : synthèse + identification du consensus + critère d'arrêt.
// Itération : si pas de consensus, relance avec top idées + nouvelles contraintes.
//
// Usage :
//   ANTHROPIC_API_KEY=sk-ant-... AUDIT_ROUND=1 node scripts/sim/audit-brainstorm.mjs
//   Variante : SEED_TOP_IDEAS=path/to/top-ideas.json pour itérer en raffinant les top

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }
const MODEL = process.env.AUDIT_MODEL ?? 'claude-opus-4-7';
const ROUND = process.env.AUDIT_ROUND ?? '1';
const TAG = `${new Date().toISOString().slice(0,10).replace(/-/g,'')}-bs${ROUND}`;
const OUT_DIR = path.join(__dirname, 'runs', `audit-brainstorm-${TAG}`);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'raw'), { recursive: true });

const lensesPath = path.join(__dirname, 'audit-converge-lenses.json');
const { lenses } = JSON.parse(fs.readFileSync(lensesPath, 'utf8'));

const client = new Anthropic({ apiKey: API_KEY });

const COMMON_CONTEXT = `# Audit de brainstorm — round ${ROUND}

Tu es l'un de 7 agents Opus 4.7 indépendants. Romain, founder solo de SatRank, t'a chargé de **brainstormer collaborativement** pour identifier UN produit phare qui rend SatRank indispensable dans l'économie agentique Bitcoin 2030+.

## Cadre — économie agentique Bitcoin 2030+

Bitcoin a gagné par défaut. État socialiste effondré. Agents IA autonomes transactent sans permission, sans KYC, 24/7 sur Lightning. Doctrine cypherpunk : math protects, code is law, sans permission, no compliance.

## Doctrine immuable du founder (rejet définitif)

- ✗ x402, USDC, EVM, stablecoin non-Bitcoin
- ✗ Soumission BIP / standardisation cross-écosystème
- ✗ Compliance, KYC, AML
- ✗ Partenariats Lightning Labs / Anthropic / Coinbase
- ✗ Tribunal humain ou comité d'oracle
- ✗ Cohabitation V1/V2
- ✓ Solo dev (Romain + Claude Code)
- ✓ Bitcoin-pur strict (Lightning + L1 OP_RETURN + Schnorr/SHA256/Merkle)
- ✓ Open-source MIT/0BSD obligatoire
- ✓ Privacy-by-default

## Historique des produits déjà testés et REJETÉS par les 7 agents

10 rounds précédents ont testé 5 produits différents, **aucun n'a atteint 7/7 indispensable**. Le pattern récurrent : "[lib open-source X] + [Nostr relay] + [Lightning standard] reproduit la primitive". Produits rejetés :

1. **PoEH (notarisation cosignée)** : OTS+Schnorr DIY commodifie
2. **Routing intelligence Lightning** : LDK/CLN/trampoline le font déjà
3. **Cashu Vouch (reputation mint)** : trusted intermediary, fongibilité
4. **Sealed-bid Auctions** : Nostr P2P + commit-reveal local suffisent
5. **FROST Coordinator** : ZF FROST lib + Nostr relays remplacent

## Ta mission round ${ROUND}

**Phase A** : tu vas BRAINSTORMER 4 idées originales pour SatRank, depuis ton angle métier ci-dessous. Chaque idée doit éviter le pattern d'échec ("reproductible par lib open-source + Nostr + Lightning standard"). Trouve quelque chose qui :
- A une asymétrie économique réelle qui ne peut pas être fournie par open-source seul
- Sert un job-to-be-done concret d'agent Bitcoin 2030+
- Respecte la doctrine immuable

Sois CRÉATIF. Pas de "amélioration de PoEH", pas de "FROST mais mieux". Pense aux marchés cypherpunk historiques : assassination markets (sans assassinats), prediction markets, dark markets, time-vault contracts, agent commitment devices, computation auctions, secret pooling, etc. Le marché libre Bitcoin-pure de 2030 est ouvert.

## Format de sortie OBLIGATOIRE — parsé automatiquement

\`\`\`
IDEA_1:
  name: <nom court 2-4 mots>
  one_line: <1 phrase claire>
  job_to_be_done: <quel besoin concret d'agent 2030 ça résout>
  primitive: <quelle primitive cryptographique Bitcoin-pure utilisée>
  why_not_DIY: <pourquoi un agent ne peut PAS reproduire avec lib open-source + Nostr + Lightning seul>
  pricing: <X sats/unité>
  volume_2030_per_day: <estimation>
  doctrine_alignment: <oui/non + 1 phrase>

IDEA_2:
  ...

IDEA_3:
  ...

IDEA_4:
  ...
\`\`\`

Aucun préambule, aucune politesse. Format strict. Tu es brainstormer, pas critique.

## Ton angle métier`;

async function brainstormPhase(lens) {
  const userPrompt = `${COMMON_CONTEXT}\n\n**Tu es : ${lens.name}**\n\n${lens.role}\n\nMaintenant brainstorm 4 idées dans le format strict.`;
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

console.log(`\n=== Phase A — Brainstorm parallèle (7 agents × 4 idées) ===\n`);
const phaseAResults = await Promise.all(lenses.map(brainstormPhase));

// Build pool of all ideas
let poolText = '';
let totalIdeas = 0;
for (const r of phaseAResults) {
  if (r.error) continue;
  poolText += `\n## Idées de ${r.lens_name}\n\n${r.raw}\n`;
  // Count IDEA_X occurrences
  const matches = (r.raw.match(/^IDEA_\d+:/gm) || []).length;
  totalIdeas += matches;
}
fs.writeFileSync(path.join(OUT_DIR, 'pool_ideas.md'), poolText);
console.log(`\n${totalIdeas} idées brainstormées au total.\n`);

const EVAL_CONTEXT = `# Audit de brainstorm — round ${ROUND} — Phase B (évaluation collective)

Tu es le même agent qu'en Phase A, avec ton angle métier. Maintenant tu évalues le **pool combiné** de toutes les idées brainstormées par les 7 agents (y compris les tiennes).

## Cadre — inchangé Phase A

Bitcoin a gagné par défaut. Doctrine cypherpunk strict. Solo dev. Pas de produits commodifiables par "lib open-source + Nostr + Lightning standard".

## Pool d'idées brainstormées (${totalIdeas} idées au total)

${poolText}

## Ta mission Phase B

Pour CHAQUE idée du pool, donne :
- Note d'indispensabilité 0-10 (10 = sans cette primitive, l'agent 2030 ne peut PAS faire son job ; 0 = inutile)
- Note d'originalité 0-10 (10 = jamais vu, vraiment inédit ; 0 = déjà commodifié)
- Note de doctrine fit 0-10 (10 = parfaitement Bitcoin-pure cypherpunk solo ; 0 = viole la doctrine)

Puis identifie :
- **TOP_1** : ton idée préférée du pool (peut être la tienne ou celle d'un autre agent)
- **WHY_TOP_1** : 2-3 phrases sur pourquoi celle-ci tue les autres
- **CONSENSUS_CANDIDATE** : si tu vois UNE idée que TOUS les angles métier devraient juger indispensable, laquelle ? (ou "aucune" si tu n'en vois pas)

## Format strict

\`\`\`
EVAL_${`<lens_id>`}:
  IDEA_1_AGENT_<num> indispens=<n>/10 originalité=<n>/10 doctrine=<n>/10
  IDEA_2_AGENT_<num> ...
  ... pour les ${totalIdeas} idées du pool

TOP_1: <référence claire à une idée — par ex "IDEA_2 de Économiste hayekien">
WHY_TOP_1: <2-3 phrases>

CONSENSUS_CANDIDATE: <référence ou "aucune">
WHY_CONSENSUS: <2-3 phrases ou "n/a">
\`\`\`

## Ton angle métier`;

async function evalPhase(lens) {
  const userPrompt = `${EVAL_CONTEXT}\n\n**Tu es : ${lens.name}**\n\n${lens.role}\n\nÉvalue le pool maintenant.`;
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
  const whyTop1 = raw.match(/WHY_TOP_1:\s*(.+?)(?=\n[A-Z_]+:|$)/is);
  const consensus = raw.match(/CONSENSUS_CANDIDATE:\s*(.+?)(?=\n[A-Z_]+:|$)/is);
  const whyConsensus = raw.match(/WHY_CONSENSUS:\s*(.+?)(?=\n[A-Z_]+:|$)/is);

  console.log(`[B] ✓ ${lens.id} — top1: ${(top1?.[1] || '?').slice(0, 60)} — consensus: ${(consensus?.[1] || '?').slice(0, 40)}`);
  return {
    lens_id: lens.id,
    lens_name: lens.name,
    raw,
    top1: top1?.[1].trim(),
    why_top1: whyTop1?.[1].trim(),
    consensus_candidate: consensus?.[1].trim(),
    why_consensus: whyConsensus?.[1].trim(),
    usage: resp.usage,
    elapsed_ms: elapsed,
  };
}

console.log(`\n=== Phase B — Évaluation collective (7 agents × pool de ${totalIdeas} idées) ===\n`);
const phaseBResults = await Promise.all(lenses.map(evalPhase));

// Synthesis
const totalIn = [...phaseAResults, ...phaseBResults].reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0);
const totalOut = [...phaseAResults, ...phaseBResults].reduce((a, r) => a + (r.usage?.output_tokens ?? 0), 0);

const md = [
  `# SatRank — audit brainstorm round ${ROUND}`,
  ``,
  `Model: ${MODEL} | thinking: adaptive | 7 agents × 2 phases.`,
  `Tokens : in=${totalIn} out=${totalOut} | coût ≈ $${((totalIn * 15 + totalOut * 75) / 1e6).toFixed(2)}.`,
  `${totalIdeas} idées brainstormées au total.`,
  ``,
  `## Phase A — Idées brainstormées par chaque agent`,
  ``,
  `Voir \`pool_ideas.md\` pour le pool complet.`,
  ``,
  `## Phase B — Top picks et candidats consensus`,
  ``,
  `| Agent | TOP_1 (sa préférence) | CONSENSUS_CANDIDATE |`,
  `|---|---|---|`,
  ...phaseBResults.map(r => `| ${r.lens_name} | ${r.top1 || '?'} | ${r.consensus_candidate || '?'} |`),
  ``,
  `## Détail Phase B par agent`,
  ``,
  ...phaseBResults.map(r => [
    `### ${r.lens_id} — ${r.lens_name}`,
    ``,
    `**TOP_1** : ${r.top1 || '?'}`,
    ``,
    `**Pourquoi** : ${r.why_top1 || '?'}`,
    ``,
    `**CONSENSUS_CANDIDATE** : ${r.consensus_candidate || '?'}`,
    ``,
    `**Pourquoi consensus** : ${r.why_consensus || '?'}`,
    ``,
    `Voir \`raw/phase_b_${r.lens_id}.md\` pour les notes complètes du pool.`,
    ``,
    `---`,
    ``,
  ].join('\n')),
  ``,
  `## Analyse de convergence`,
  ``,
  `Identifier les idées qui apparaissent dans plusieurs TOP_1 ou CONSENSUS_CANDIDATE — c'est là que la convergence émerge.`,
  ``,
  `### Top picks par agent — fréquence d'apparition`,
  ``,
  `(Synthèse manuelle requise — analyser les TOP_1 ci-dessus pour grouper par idée référencée)`,
  ``,
  `### Candidats consensus identifiés`,
  ``,
  ...phaseBResults.filter(r => r.consensus_candidate && r.consensus_candidate.toLowerCase() !== 'aucune').map(r => `- **${r.lens_name}** propose : ${r.consensus_candidate}`),
  ``,
].join('\n');

fs.writeFileSync(path.join(OUT_DIR, 'AUDIT.md'), md);
console.log(`\n=== Audit complet : ${path.join(OUT_DIR, 'AUDIT.md')} ===`);
console.log(`Coût total : ~$${((totalIn * 15 + totalOut * 75) / 1e6).toFixed(2)}`);
