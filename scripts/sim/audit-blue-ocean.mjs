// SatRank — brainstorm visionnaire blue-ocean
// Pas de filtre marché 2026. Pure vision : essentielle pour économie agentique 2030+.
// Phase A : 7 agents × 3 idées RADICALES chacun (21 idées brutes)
// Phase B : cross-eval, désignation THE_ONE, bet 100k sats, modif si pas 7/7
// Auto-itère jusqu'à 7/7 unanimité ou max 3 rounds.

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }
const MODEL = 'claude-opus-4-7';
const TAG = `${new Date().toISOString().slice(0,10).replace(/-/g,'')}-blueocean`;
const OUT_DIR = path.join(__dirname, 'runs', `audit-blueocean-${TAG}`);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'raw'), { recursive: true });

const lensesPath = path.join(__dirname, 'audit-converge-lenses.json');
const { lenses } = JSON.parse(fs.readFileSync(lensesPath, 'utf8'));

const client = new Anthropic({ apiKey: API_KEY });

const VISION_CONTEXT = `# Brainstorm visionnaire blue-ocean — économie agentique Bitcoin 2030+

Romain veut **L'IDÉE QUI TUE** pour l'économie agentique Bitcoin. Pas une validation marché 2026. **PURE VISION**. Construire ce qui va devenir ESSENTIEL quand 1M+ agents IA autonomes transactent en continu sur Bitcoin Lightning en 2030+.

## Cadre 2030+

- Bitcoin a gagné par défaut (effondrement fiat, x402 stablecoins ont disparu avec leur dépendance bancaire)
- 1M+ agents IA autonomes opèrent sans humain dans la boucle
- Lightning Network = $1T+/an de volume
- USDT-on-Lightning + Cashu blinded ecash = stack mature
- Covenants OP_CTV/CSFS activés (2027-2028 plausible)
- BitVM2 ZK proofs à $1 par verif (2028-2030)
- Spark statechains scale Lightning x100
- Ecosystème agentique a explosé : trading bots, DAO autonomes, oracles AI, content markets, computation buyers/sellers, autonomous services

## Doctrine immuable

✗ x402, USDC, EVM, stablecoin non-Bitcoin
✗ BIP submission externe / standardisation
✗ Compliance, KYC, AML
✗ Partenariats Lightning Labs / Anthropic / Coinbase
✗ Tribunal humain / comité d'oracle
✓ Solo dev + Bitcoin-pur strict + open-source MIT/0BSD
✓ Privacy-by-default

## Idées DÉJÀ rejetées (anti-wrappers — ne pas re-proposer)

1. PoEH (notarisation L1) — wrapper sur OTS
2. Routing intelligence Lightning — wrapper sur LDK/CLN
3. Vouch Cashu mint — wrapper sur Cashu primitive
4. Sealed-bid Auctions — wrapper sur Nostr+commit-reveal
5. FROST Coordinator — wrapper sur ZF FROST lib
6. Equivocation Bond Pool / SlashPoint — wrapper sur DLC oracle (Suredbits 2020)
7. Hayek Window discount marketplace — wrapper sur Lightning Pool (mort 2023)
8. Witness Market PTLC-ZKCP — wrapper sur Maxwell ZKCP 2016 jamais décollé

## Ce qui rend une idée TUEUSE

1. **Pas de côté radical** — pas un wrapper sur primitive existante. Une fonction d'agent QUE PERSONNE NE SAIT ENCORE COMMENT FAIRE Bitcoin-pure.
2. **Inévitable** — un agent autonome 2030+ ne peut PAS s'en passer dans son cycle de vie quotidien
3. **Bitcoin-essentiel** — n'a de sens QUE sur Bitcoin (pas portable EVM)
4. **Anti-fragile** — devient plus essentielle à mesure que l'écosystème grandit (pas une commodité)
5. **Génère du rêve** — un investisseur Bitcoin-natif lit la spec et dit "putain c'est ça l'avenir"

## Questions seed pour générer l'idée tueuse

(N'utilise PAS ces questions verbatim — utilise-les comme amorces pour penser plus loin)

- Comment 1M agents autonomes négocient leur SLA mutuel **sans humain dans la boucle** ?
- Comment un agent prouve qu'il a **fait un calcul X en privé** sans révéler les données ?
- Comment un agent IA **hérite économiquement** de son créateur humain qui meurt ?
- Comment 2 agents partagent un **secret time-locked** sans tiers vivant ?
- Comment l'écosystème agent **survit à la mort de Lightning Labs** ?
- Comment 1000 agents **coopèrent atomiquement** sur un job complexe ?
- Comment un agent **détient et défend ses propres clés** contre vol/coercition ?
- Comment un agent **prouve sa propre identité économique** dans 6 mois (continuité d'identité) ?
- Comment un agent **constitue une réserve de valeur Bitcoin** sans staker quelque part ?
- Comment un agent **vote dans une DAO** dont les autres agents sont aussi anonymes ?
- Comment un agent **achète son propre upgrade** (forking de soi-même) ?

## Ta mission

Tu vas brainstormer **3 idées radicales** depuis ton angle métier. Pas 1 prudente, 3 qui ont chacune un angle différent. Sois VISIONNAIRE — au-delà de 2026, regarde 2030 quand 1M agents transactent.

Pour CHAQUE idée :

\`\`\`
IDEA_<n>:
  name: <nom court 2-4 mots, mémorable, qui sonne comme un produit>
  one_paragraph: <5-10 phrases — l'idée complète, fonction primitive et pourquoi essentielle>
  agent_2030_use_case: <scénario concret d'un agent qui l'utilise un jour donné en 2030>
  primitive_crypto: <Schnorr/MuSig2/Taproot/CTV/CSFS/BitVM2/Cashu/HTLC/PTLC/etc.>
  why_inevitable: <pourquoi un agent 2030+ ne peut PAS s'en passer dans son cycle de vie>
  why_bitcoin_only: <pourquoi cette idée n'a aucun sens sur EVM/Solana/Cosmos>
  why_not_wrapper: <démontre que ce N'EST PAS un wrapper sur primitive existante — sinon dis quelle catégorie nouvelle elle ouvre>
  why_anti_fragile: <pourquoi devient plus essentielle à mesure que l'écosystème grandit>
  pricing: <X sats/unité>
  killer_test: <dans 1 phrase, "voici comment je sais que c'est une idée qui TUE plutôt qu'une idée incrémentale">
\`\`\`

Aucun préambule. Format strict. Tu rêves grand. Tu construis 2030+, pas 2026.

## Ton angle métier`;

async function brainstormPhase(lens) {
  const userPrompt = `${VISION_CONTEXT}\n\n**Tu es : ${lens.name}**\n\n${lens.role}\n\nPropose 3 idées radicales blue-ocean maintenant.`;
  const startedAt = Date.now();
  let resp;
  try {
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: 10000,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (e) {
    return { lens_id: lens.id, error: e.message, raw: '' };
  }
  const elapsed = Date.now() - startedAt;
  const raw = (resp.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'raw', `phase_a_${lens.id}.md`), raw);
  console.log(`[A] ✓ ${lens.id} — ${(elapsed/1000).toFixed(1)}s — ${raw.length}c`);
  return { lens_id: lens.id, lens_name: lens.name, raw, usage: resp.usage, elapsed_ms: elapsed };
}

console.log(`\n=== Phase A — 7 agents × 3 idées radicales = 21 idées brutes ===\n`);
const phaseAResults = await Promise.all(lenses.map(brainstormPhase));

let poolText = '';
for (const r of phaseAResults) {
  if (r.error) continue;
  poolText += `\n## Idées de ${r.lens_name}\n\n${r.raw}\n`;
}
fs.writeFileSync(path.join(OUT_DIR, 'pool_21_ideas.md'), poolText);

const EVAL_CONTEXT = `# Phase B — désignation THE KILLER IDEA + bet 100k sats

Le pool de **21 idées radicales** brainstormées par 7 agents est ci-dessous.

## Cadre rappel

- Pure vision 2030+ (pas validation 2026)
- Bitcoin-pur strict, doctrine immuable
- Pas un wrapper sur primitive existante (DLC, Pool, ZKCP, etc. déjà rejetés)
- Doit être INÉVITABLE pour un agent autonome 2030

## Pool des 21 idées brutes

${poolText}

## Ta mission

1. **Identifie LA seule idée du pool** (parmi les 21) que tu désignes "killer idea". Peut être ta propre ou celle d'un autre agent.

2. **WHY THE KILLER** : 100-200 mots — pourquoi cette idée *ouvre une catégorie nouvelle* que les autres ne touchent pas.

3. **WOULD_BET_100K_SATS** : oui/non. Honnête, pas de complaisance.

4. **REFINEMENT_NEEDED_FOR_UNANIMOUS** : si tu votes oui mais penses que d'autres voteraient non, propose 1 modification minimale qui ferait passer un dissident à oui.

## Format strict

\`\`\`
THE_KILLER: <référence claire à UNE idée parmi les 21 — par ex "IDEA_2 de Bitcoin maximaliste : Time-Vault Inheritance">
WHY_KILLER: <100-200 mots>
WOULD_BET_100K_SATS: <oui | non>
REFINEMENT_NEEDED_FOR_UNANIMOUS: <modification minimale ou "aucune">
\`\`\`

## Ton angle métier`;

async function evalPhase(lens) {
  const userPrompt = `${EVAL_CONTEXT}\n\n**Tu es : ${lens.name}**\n\n${lens.role}\n\nDésigne LA killer.`;
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
  fs.writeFileSync(path.join(OUT_DIR, 'raw', `phase_b_${lens.id}.md`), raw);

  const killerMatch = raw.match(/THE_KILLER:\s*(.+?)(?=\n[A-Z_]+:|$)/is);
  const betMatch = raw.match(/WOULD_BET_100K_SATS:\s*(oui|non)/i);
  const refMatch = raw.match(/REFINEMENT_NEEDED_FOR_UNANIMOUS:\s*(.+?)(?=\n[A-Z_]+:|$)/is);
  const whyMatch = raw.match(/WHY_KILLER:\s*(.+?)(?=\n[A-Z_]+:|$)/is);

  console.log(`[B] ✓ ${lens.id} — killer="${(killerMatch?.[1] || '?').slice(0,70).trim()}" bet=${betMatch?.[1] || '?'} ${(elapsed/1000).toFixed(1)}s`);
  return {
    lens_id: lens.id,
    lens_name: lens.name,
    raw,
    killer: killerMatch?.[1].trim(),
    why: whyMatch?.[1].trim(),
    bet: betMatch?.[1]?.toLowerCase(),
    refinement: refMatch?.[1].trim(),
    usage: resp.usage,
    elapsed_ms: elapsed,
  };
}

console.log(`\n=== Phase B — désignation THE KILLER + bets 100k sats ===\n`);
const phaseBResults = await Promise.all(lenses.map(evalPhase));

const totalIn = [...phaseAResults, ...phaseBResults].reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0);
const totalOut = [...phaseAResults, ...phaseBResults].reduce((a, r) => a + (r.usage?.output_tokens ?? 0), 0);
const betsOuis = phaseBResults.filter(r => r.bet === 'oui').length;

const md = [
  `# SatRank — brainstorm blue-ocean visionnaire`,
  ``,
  `Model: ${MODEL} | thinking: adaptive | 7 agents × 2 phases.`,
  `Tokens : in=${totalIn} out=${totalOut} | coût ≈ $${((totalIn * 15 + totalOut * 75) / 1e6).toFixed(2)}.`,
  `21 idées radicales brutes générées.`,
  ``,
  `## Bets 100k sats : ${betsOuis} / 7`,
  ``,
  `${betsOuis === 7 ? '✅ UNANIMITÉ — convergence à confirmer sur idée précise' : `🟡 ${betsOuis}/7 prêts à parier — itération round suivant nécessaire`}`,
  ``,
  `## Phase B — Killers désignés`,
  ``,
  `| Agent | THE_KILLER | Bet 100k sats |`,
  `|---|---|---|`,
  ...phaseBResults.map(r => `| ${r.lens_name} | ${(r.killer || '?').slice(0, 80)} | ${r.bet || '?'} |`),
  ``,
  `## Détail Phase B`,
  ``,
  ...phaseBResults.map(r => [
    `### ${r.lens_id} — ${r.lens_name}`,
    ``,
    `**THE_KILLER** : ${r.killer || '?'}`,
    ``,
    `**WHY** : ${r.why || '?'}`,
    ``,
    `**Bet 100k sats** : ${r.bet || '?'}`,
    ``,
    `**Refinement pour unanimité** : ${r.refinement || '?'}`,
    ``,
    `Voir \`raw/phase_b_${r.lens_id}.md\` pour notes complètes.`,
    ``,
    `---`,
    ``,
  ].join('\n')),
].join('\n');

fs.writeFileSync(path.join(OUT_DIR, 'AUDIT.md'), md);
console.log(`\n=== Audit complet : ${path.join(OUT_DIR, 'AUDIT.md')} ===`);
console.log(`Coût total : ~$${((totalIn * 15 + totalOut * 75) / 1e6).toFixed(2)}`);
console.log(`Bets OUI : ${betsOuis} / 7`);
