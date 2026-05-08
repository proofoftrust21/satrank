// SatRank — audit de convergence sur la spec PoEH.
// 7 agents indépendants votent OUI/NON binaire avec blocker précis si NON.
// Itérations jusqu'à 7/7 OUI ou identification du désaccord structurel.
//
// Usage :
//   ANTHROPIC_API_KEY=sk-ant-... AUDIT_ROUND=1 node scripts/sim/audit-converge.mjs
//
// Le SPEC à valider est lu depuis : scripts/sim/spec-poeh-v<X>.md
// L'env SPEC_FILE override le path.

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }
const MODEL = process.env.AUDIT_MODEL ?? 'claude-opus-4-7';
const ROUND = process.env.AUDIT_ROUND ?? '1';
const TAG = `${new Date().toISOString().slice(0,10).replace(/-/g,'')}-r${ROUND}`;
const MAX_TOKENS = Number(process.env.AUDIT_MAX_TOKENS ?? 8000);
const SPEC_FILE = process.env.SPEC_FILE ?? path.join(__dirname, 'spec-poeh-v0.1.md');
const OUT_DIR = path.join(__dirname, 'runs', `audit-converge-${TAG}`);
const RAW_DIR = path.join(OUT_DIR, 'raw');
fs.mkdirSync(RAW_DIR, { recursive: true });

const lensesPath = path.join(__dirname, 'audit-converge-lenses.json');
const { lenses } = JSON.parse(fs.readFileSync(lensesPath, 'utf8'));
const SPEC = fs.readFileSync(SPEC_FILE, 'utf8');

const client = new Anthropic({ apiKey: API_KEY });

const COMMON_PREAMBLE = `# Audit de convergence — round ${ROUND}

Tu es l'un de 7 agents Opus 4.7 indépendants (sans coordination entre vous). Romain, founder solo de SatRank, t'a chargé de juger une spec produit. Il a explicitement dit qu'il ne veut pas perdre de temps : il veut un OUI ou un NON binaire avec un blocker précis si NON, pas un essai.

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
- ✓ Bitcoin-pur strict (Lightning + L1 OP_RETURN + Schnorr)

## La spec à juger

\`\`\`
${SPEC}
\`\`\`

## Format de réponse OBLIGATOIRE — 2 dimensions

Tu votes sur **2 questions distinctes**, indépendantes, chacune binaire OUI/NON :

1. **SPEC_VALIDE** — la spec est-elle techniquement et doctrinairement saine ? (faisable solo, Bitcoin-pur, pas d'usine à gaz, cohérente, pas de faille structurelle)
2. **INDISPENSABLE** — cette primitive est-elle réellement INDISPENSABLE pour le job-to-be-done de ton angle métier ? Pas "utile", pas "améliore" — vraiment "sans elle ça ne marche pas, ou ça ne marche qu'avec friction prohibitive". Le test : un agent rationnel 2030 utilisant ton angle métier l'utilise par défaut sans alternative équivalente.

Tu peux voter OUI/OUI, OUI/NON, NON/OUI, NON/NON. Sois honnête sur les deux.

Format strict (parsé automatiquement) — aucun préambule, aucune politesse :

\`\`\`
SPEC_VALIDE: OUI ou NON (un seul mot)
INDISPENSABLE: OUI ou NON (un seul mot)
BLOCKER_SPEC: [si SPEC_VALIDE=NON, blocker structurel en 1 phrase. Sinon "n/a"]
BLOCKER_INDISPENSABLE: [si INDISPENSABLE=NON, ce qui manque pour qu'elle le devienne, en 1 phrase. Sinon "n/a"]
JUSTIFICATION: [200-400 mots. Argumente les 2 votes. Pas de hand-waving. Aucune phrase qui commence par "cependant" ou "néanmoins". Ton angle métier ci-dessous.]
\`\`\`

## Ton angle métier`;

async function callLens(lens) {
  const userPrompt = `${COMMON_PREAMBLE}\n\n**Tu es : ${lens.name}**\n\n${lens.role}\n\nMaintenant vote.`;
  const startedAt = Date.now();
  let resp;
  try {
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (e) {
    return { lens_id: lens.id, lens_name: lens.name, error: e.message, raw_text: '' };
  }
  const elapsed = Date.now() - startedAt;
  const textBlocks = (resp.content ?? []).filter(b => b.type === 'text').map(b => b.text);
  const raw = textBlocks.join('\n\n');
  fs.writeFileSync(path.join(RAW_DIR, `${lens.id}.md`), `# ${lens.id} — ${lens.name}\n\n${raw}\n`);

  // Parse the 2-dimensional structured vote
  const specMatch = raw.match(/SPEC_VALIDE:\s*(OUI|NON)/i);
  const indispMatch = raw.match(/INDISPENSABLE:\s*(OUI|NON)/i);
  const blockerSpecMatch = raw.match(/BLOCKER_SPEC:\s*(.+?)(?=\n[A-Z_]+:|\n\n|$)/is);
  const blockerIndispMatch = raw.match(/BLOCKER_INDISPENSABLE:\s*(.+?)(?=\n[A-Z_]+:|\n\n|$)/is);
  const justifMatch = raw.match(/JUSTIFICATION:\s*(.+)/is);

  const vote = {
    lens_id: lens.id,
    lens_name: lens.name,
    spec_valide: specMatch ? specMatch[1].toUpperCase() : 'PARSE_FAIL',
    indispensable: indispMatch ? indispMatch[1].toUpperCase() : 'PARSE_FAIL',
    blocker_spec: blockerSpecMatch ? blockerSpecMatch[1].trim() : '(parse fail)',
    blocker_indispensable: blockerIndispMatch ? blockerIndispMatch[1].trim() : '(parse fail)',
    justification: justifMatch ? justifMatch[1].trim() : '(parse fail)',
    raw,
    usage: resp.usage,
    elapsed_ms: elapsed,
  };
  console.log(`✓ ${lens.id} — spec=${vote.spec_valide} indisp=${vote.indispensable} — ${(elapsed / 1000).toFixed(1)}s`);
  return vote;
}

console.log(`Round ${ROUND} — ${lenses.length} agents indépendants — spec=${path.basename(SPEC_FILE)}`);
const votes = await Promise.all(lenses.map(callLens));

const specOuis = votes.filter(v => v.spec_valide === 'OUI').length;
const indispOuis = votes.filter(v => v.indispensable === 'OUI').length;
const bothOuis = votes.filter(v => v.spec_valide === 'OUI' && v.indispensable === 'OUI').length;
const totalIn = votes.reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0);
const totalOut = votes.reduce((a, r) => a + (r.usage?.output_tokens ?? 0), 0);

const consensus = (bothOuis === lenses.length);

const md = [
  `# Audit de convergence — round ${ROUND}`,
  ``,
  `Spec: \`${path.basename(SPEC_FILE)}\` | Model: ${MODEL} | thinking: adaptive | ${lenses.length} agents.`,
  `Tokens : in=${totalIn} out=${totalOut} | coût ≈ $${((totalIn * 15 + totalOut * 75) / 1e6).toFixed(2)}.`,
  ``,
  `## Score (2 dimensions)`,
  ``,
  `- **SPEC_VALIDE** : ${specOuis} / ${lenses.length} OUI`,
  `- **INDISPENSABLE** : ${indispOuis} / ${lenses.length} OUI`,
  `- **OUI / OUI sur les 2 axes** : ${bothOuis} / ${lenses.length}`,
  ``,
  `**${consensus ? '✅ CONSENSUS COMPLET ATTEINT (7/7 sur les 2 axes)' : '❌ PAS DE CONSENSUS COMPLET — itérer'}**`,
  ``,
  `## Tableau des votes`,
  ``,
  `| Agent | Spec | Indisp | Blocker spec | Blocker indispensable |`,
  `|---|---|---|---|---|`,
  ...votes.map(v => `| ${v.lens_name} | ${v.spec_valide} | ${v.indispensable} | ${v.spec_valide === 'NON' ? v.blocker_spec : '—'} | ${v.indispensable === 'NON' ? v.blocker_indispensable : '—'} |`),
  ``,
  `## Détail par agent`,
  ``,
  ...votes.map(v => [
    `### ${v.lens_id} — ${v.lens_name}`,
    ``,
    `**SPEC_VALIDE** : ${v.spec_valide}`,
    `**INDISPENSABLE** : ${v.indispensable}`,
    `**Blocker spec** : ${v.blocker_spec}`,
    `**Blocker indispensable** : ${v.blocker_indispensable}`,
    ``,
    `**Justification** :`,
    ``,
    v.justification,
    ``,
    `---`,
    ``,
  ].join('\n')),
  ``,
  `## Synthèse des blockers à intégrer dans v${parseInt(ROUND, 10) + 1}`,
  ``,
  `### Blockers SPEC`,
  ``,
  ...votes.filter(v => v.spec_valide === 'NON').map(v => `- **${v.lens_name}** : ${v.blocker_spec}`),
  ``,
  `### Blockers INDISPENSABILITÉ`,
  ``,
  ...votes.filter(v => v.indispensable === 'NON').map(v => `- **${v.lens_name}** : ${v.blocker_indispensable}`),
].join('\n');

const outPath = path.join(OUT_DIR, 'AUDIT.md');
fs.writeFileSync(outPath, md);
console.log(`\n${consensus ? '✅' : '❌'} Round ${ROUND} : spec=${specOuis}/${lenses.length} indisp=${indispOuis}/${lenses.length} both=${bothOuis}/${lenses.length}`);
console.log(`Audit : ${outPath}`);
