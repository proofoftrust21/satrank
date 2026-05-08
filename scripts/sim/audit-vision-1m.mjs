// SatRank — audit visionnaire "1M sats killer idea"
// Phase A : 1 idée ULTRA-travaillée par agent (au lieu de 4 superficielles)
// Phase B : chaque agent évalue le pool de 7 idées + désigne LA killer
// Phase C : si convergence claire → spec ; sinon round 2 avec contraintes raffinées

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }
const MODEL = 'claude-opus-4-7';
const ROUND = process.env.AUDIT_ROUND ?? '1';
const TAG = `${new Date().toISOString().slice(0,10).replace(/-/g,'')}-vis1m-r${ROUND}`;
const OUT_DIR = path.join(__dirname, 'runs', `audit-vision-1m-${TAG}`);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'raw'), { recursive: true });

const lensesPath = path.join(__dirname, 'audit-converge-lenses.json');
const { lenses } = JSON.parse(fs.readFileSync(lensesPath, 'utf8'));

const client = new Anthropic({ apiKey: API_KEY });

const COMMON_CONTEXT = `# Audit visionnaire "1M sats killer idea" — round ${ROUND}

Tu es l'un de 7 agents Opus 4.7 indépendants. Romain, founder solo de SatRank, te charge de **brainstormer LA seule idée** qui peut générer 1M+ sats/jour de revenu pour SatRank dans l'économie agentique Bitcoin 2027-2030. Pas un brainstorm superficiel — UNE idée ultra-travaillée que tu défends avec rigueur visionnaire.

## Cadre — économie agentique Bitcoin 2027-2030

### État Bitcoin mai 2026 (factuel, sourcé)

- **USDT live sur Lightning** via Taproot Assets depuis 21 mars 2026 (Tether confirmation)
- **Taproot Assets v0.7** déc 2025 : reusable static addresses, multi-RFQ, asset MPP
- **Lightning** : $10B/an de volume avec $500M capacité ($9.7T forex à terme, énorme upside)
- **BitVM2 ZK proofs** : coût verif $14k → $100 sur Bitcoin L1 (révolution)
- **OP_CTV/CSFS covenants** : proposal d'activation 30 mars 2026, timeout 2027, hauteur min mai 2027 — débat communautaire actif
- **Cashu / Fedimint** : matures, "Ecash Coffee Day" merchant adoption
- **Spark statechains** : gagne traction throughput
- **Openclaw** (Alby fév 2026) : *premier* agent IA documenté qui spin up sa propre infra et achète AI credits via Lightning

### Concurrence agents (factuel)

- **x402 (Coinbase HTTP 402 micropayments)** : $48M volume, 95% sur Base EVM
- **Google AP2** : protocole agent payment standard
- Coinbase Jesse Pollak : "AI agents = next wave for crypto payments"
- **DLC oracles Bitcoin** (Suredbits) : ~50 oracles, <$1M volume/mois — embryonnaire
- **Nostr DVM (NIP-90)** : marketplace data processing kinds 5000-7000

### Thèse Bitcoin-pure souveraine (doctrine Romain)

x402 marche aujourd'hui parce que Coinbase pousse + USDC profite taux T-bills. **Stablecoins ont dépendance bancaire que Bitcoin n'a pas**. Si Fed coupe taux, USDC perd business model. Vitalik a fait l'erreur originelle de critiquer PoW = ancrage thermodynamique. **Bitcoin gagne à long terme** parce qu'il est ancré dans la réalité physique (énergie), pas dans la confiance circulaire d'institutions. **x402 tombera aux oubliettes**, comme Terra Luna a fait.

Le pari : SatRank construit l'infrastructure agentique Bitcoin-pure pour le moment où l'écosystème EVM fragmenté craque et où les agents Bitcoin sérieux émergent en masse (2027-2030+).

## Doctrine immuable (rejet définitif)

✗ x402, USDC, EVM, stablecoin non-Bitcoin
✗ BIP submission externe / standardisation cross-écosystème
✗ Compliance, KYC, AML
✗ Partenariats Lightning Labs / Anthropic / Coinbase
✗ Tribunal humain ou comité d'oracle
✓ Solo dev (Romain + Claude Code)
✓ Bitcoin-pur strict (Lightning + L1 OP_RETURN + Schnorr/SHA256/Merkle/MuSig2/Taproot)
✓ Open-source MIT/0BSD obligatoire dès J1
✓ Privacy-by-default

## Idées DÉJÀ testées et REJETÉES (à éviter)

10+ rounds, 6 produits différents, plafonnement à 4-5/7 indispensable :

1. **PoEH (notarisation L1 cosignée)** — OTS+Schnorr DIY commodifie
2. **Routing intelligence Lightning** — LDK/CLN/trampoline le font déjà
3. **Vouch Cashu (reputation mint)** — fongibilité tokens, trusted intermediary
4. **Sealed-bid Auctions** — Nostr P2P + commit-reveal local suffisent
5. **FROST Coordinator** — ZF FROST lib + Nostr relays remplacent
6. **Equivocation Bond Pool** — plafonné 4/7 sans covenants OP_CTV

Pas un raffinement de ces idées — un **angle radicalement nouveau**.

## Ta mission round ${ROUND}

Brainstorme **UNE SEULE idée** ultra-travaillée. Pas 4 superficielles — 1 profonde. Défends-la comme si tu mettais ton argent personnel dessus.

L'idée doit :

1. **Générer 1M+ sats/jour de revenu pour SatRank à maturité 2027-2030** (= ~$600/jour minimum, $200k/an minimum)
2. **Bitcoin-pur strict** (respect doctrine immuable)
3. **Indispensable par construction OU par effet de réseau cumulatif** non reproductible par DIY ("lib open-source + Nostr + Lightning standard")
4. **Shippable solo** par Romain en 30-60 jours
5. **Volume agent-natif** : utilisée plusieurs fois par jour par chaque agent qui en a besoin
6. **Slot ouvert** : pas déjà occupé par x402, Cashu mint generic, OTS, DLC oracles existants
7. **Profite de la vague 2027+** : si covenants activent, l'idée devient encore plus puissante

Sois VISIONNAIRE. Pense à des marchés cypherpunk historiques inexploités :
- Markets sans intermédiaire (May 1988 CryptoNet)
- Information markets sans censure (whistleblowing economics)
- Computation markets verifiable (BitVM2 enabled)
- Time-vault contracts (VDF + L1 anchor)
- Reputation as bearer asset (Cashu-style)
- Stablecoin alternative ancré activité économique (vs T-bills banking)
- Energy markets P2P signed by hash power
- Mempool-as-a-service (post-CTV)
- ZK proof markets (BitVM2 verifiable)
- Inter-agent legal contracts (sans tribunal)
- Embargo/dead-man primitives crédibles
- Anti-Sybil identity ancrée par burn
- Liquidity primitives Lightning M2M
- Privacy-preserving payment routing
- Cross-domain authentication (Schnorr Universal)

Ou des idées que personne n'a encore vu venir.

## Format strict (parsé automatiquement)

\`\`\`
KILLER_IDEA:
  name: <nom court 2-4 mots, mémorable>
  one_paragraph: <1 paragraphe clair de 5-10 phrases qui décrit l'idée>
  job_to_be_done: <quel besoin concret d'agent Bitcoin 2030 ça résout — soit précis>
  primitive_crypto: <quelle primitive Bitcoin-pure exacte — Schnorr, MuSig2, BIP-340, Taproot, BitVM2, BIP-119, etc.>
  why_indispensable: <argument 100-200 mots sur pourquoi indispensable par construction>
  why_not_DIY: <pourquoi un agent ne peut PAS reproduire avec lib open-source + Nostr + Lightning seul>
  pricing: <X sats/unité>
  volume_2030_per_day: <estimation justifiée — combien d'usages/jour à maturité>
  revenue_satrank_per_day_2030: <calcul qui mène à ≥1M sats/jour>
  doctrine_alignment: <oui/non + 1 phrase>
  shippability_solo_dev: <faisable Romain solo en 30-60j ? oui/non + raison>
  competitor_threat: <qui pourrait reproduire et en combien de temps>
  bullshit_test: <pour chaque idée, une phrase qui dit "voici comment je sais que c'est PAS du bullshit cypherpunk"

PERSONAL_BET: <oui je parie 100k sats / non je ne parie pas + 1 phrase>
\`\`\`

Aucun préambule, aucune politesse, aucun "j'espère que ça aide". Tu es brainstormer ; sois sec, précis, courageux.

## Ton angle métier`;

async function brainstormPhase(lens) {
  const userPrompt = `${COMMON_CONTEXT}\n\n**Tu es : ${lens.name}**\n\n${lens.role}\n\nPropose UNE killer idea ultra-travaillée maintenant.`;
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
  fs.writeFileSync(path.join(OUT_DIR, 'raw', `phase_a_${lens.id}.md`), raw);

  const nameMatch = raw.match(/name:\s*(.+?)(?=\n|$)/i);
  const betMatch = raw.match(/PERSONAL_BET:\s*(oui|non)/i);
  console.log(`[A] ✓ ${lens.id} — "${(nameMatch?.[1] || '?').trim()}" — bet=${betMatch?.[1] || '?'} — ${(elapsed/1000).toFixed(1)}s`);

  return { lens_id: lens.id, lens_name: lens.name, raw, idea_name: (nameMatch?.[1] || '?').trim(), bet: betMatch?.[1], usage: resp.usage, elapsed_ms: elapsed };
}

console.log(`\n=== Phase A — 7 killer ideas ultra-travaillées ===\n`);
const phaseAResults = await Promise.all(lenses.map(brainstormPhase));

let poolText = '';
for (const r of phaseAResults) {
  if (r.error) { poolText += `\n## ${r.lens_name}\n[ERROR: ${r.error}]\n`; continue; }
  poolText += `\n## Killer idea de ${r.lens_name}\n\n${r.raw}\n`;
}
fs.writeFileSync(path.join(OUT_DIR, 'pool_killers.md'), poolText);

const EVAL_CONTEXT = `# Audit visionnaire "1M sats killer idea" — Phase B

Tu es le même agent qu'en Phase A. Le pool de **7 killer ideas ultra-travaillées** (1 par agent) est ci-dessous. Évalue-les avec lucidité brutale.

## Pool des 7 killer ideas

${poolText}

## Cadre rappel

- 1M+ sats/jour revenu SatRank à maturité 2027-2030
- Bitcoin-pur strict (no x402/EVM/stablecoin)
- Indispensable par construction OU effet réseau cumulatif
- Shippable solo Romain en 30-60j
- Pas reproductible par "lib + Nostr + LN standard"

## Ta mission Phase B

1. **Notation par idée** : pour chaque idée du pool (7 au total), donne 4 notes :
   - INDISPENSABILITÉ 0-10 (sans la primitive, l'agent ne peut PAS faire son job)
   - DOCTRINE_FIT 0-10 (Bitcoin-pur strict)
   - SHIPPABILITY 0-10 (solo dev, 30-60j)
   - REVENUE_REALISM 0-10 (le calcul 1M sats/jour 2030 tient-il ?)

2. **THE_KILLER** : LA seule idée du pool que tu vois comme la "1M sats idée". Référence claire (ex: "killer idea de Bitcoin maximaliste" ou "idée 'Lightning Routing Mempool Service'").

3. **WHY_KILLER** : 100-200 mots sur pourquoi cette idée bat les 6 autres. Sois adversarial — explique pourquoi les autres NE SONT PAS la killer.

4. **WOULD_BET_PERSONAL_100K_SATS** : oui/non sur le KILLER. Si oui, dis pourquoi. Si non sur AUCUNE des 7, dis "non sur tout le pool" + 1 phrase.

5. **REFINEMENT_NEEDED** : si le KILLER a un bug ou un blocker, lequel ? Comment le fixer en V1.1 sans casser le concept central ?

## Format strict

\`\`\`
EVAL_${`<lens_id>`}:
  IDEA_<agent_name>: indisp=<n> doctrine=<n> ship=<n> revenue=<n>
  ... pour les 7 idées

THE_KILLER: <référence claire à UNE idée du pool>
WHY_KILLER: <100-200 mots>
WOULD_BET_PERSONAL_100K_SATS: oui/non
WHY_BET: <1-3 phrases>
REFINEMENT_NEEDED: <bug/blocker à fixer ou "aucun, ship tel quel">
\`\`\`

## Ton angle métier`;

async function evalPhase(lens) {
  const userPrompt = `${EVAL_CONTEXT}\n\n**Tu es : ${lens.name}**\n\n${lens.role}\n\nÉvalue les 7 killer ideas, désigne LA killer.`;
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

  const killerMatch = raw.match(/THE_KILLER:\s*(.+?)(?=\n[A-Z_]+:|$)/is);
  const betMatch = raw.match(/WOULD_BET_PERSONAL_100K_SATS:\s*(oui|non)/i);
  const refinementMatch = raw.match(/REFINEMENT_NEEDED:\s*(.+?)(?=\n[A-Z_]+:|$)/is);

  console.log(`[B] ✓ ${lens.id} — killer: "${(killerMatch?.[1] || '?').slice(0,60).trim()}" — bet=${betMatch?.[1] || '?'} — ${(elapsed/1000).toFixed(1)}s`);

  return {
    lens_id: lens.id,
    lens_name: lens.name,
    raw,
    killer: killerMatch?.[1].trim(),
    bet: betMatch?.[1]?.toLowerCase(),
    refinement: refinementMatch?.[1].trim(),
    usage: resp.usage,
    elapsed_ms: elapsed,
  };
}

console.log(`\n=== Phase B — chaque agent désigne LA killer + bet 100k sats ===\n`);
const phaseBResults = await Promise.all(lenses.map(evalPhase));

const totalIn = [...phaseAResults, ...phaseBResults].reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0);
const totalOut = [...phaseAResults, ...phaseBResults].reduce((a, r) => a + (r.usage?.output_tokens ?? 0), 0);
const betsOuis = phaseBResults.filter(r => r.bet === 'oui').length;

const md = [
  `# SatRank — audit visionnaire "1M sats killer idea" — round ${ROUND}`,
  ``,
  `Model: ${MODEL} | thinking: adaptive | 7 agents × 2 phases.`,
  `Tokens : in=${totalIn} out=${totalOut} | coût ≈ $${((totalIn * 15 + totalOut * 75) / 1e6).toFixed(2)}.`,
  ``,
  `## Phase A — 7 killer ideas ultra-travaillées`,
  ``,
  `| Agent | Idea name | Personal bet (Phase A) |`,
  `|---|---|---|`,
  ...phaseAResults.map(r => `| ${r.lens_name} | "${r.idea_name || '?'}" | ${r.bet || '?'} |`),
  ``,
  `Voir \`pool_killers.md\` pour les 7 idées complètes.`,
  ``,
  `## Phase B — désignation du KILLER + bet 100k sats`,
  ``,
  `**Bets OUI** : ${betsOuis} / 7`,
  ``,
  `${betsOuis === 7 ? '✅ CONSENSUS — tous prêts à parier 100k sats sur leur killer pick' : betsOuis >= 5 ? '🟡 majorité prête à parier' : '❌ pas de consensus solide'}`,
  ``,
  `| Agent | THE_KILLER désigné | Bet 100k sats |`,
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
    `**Bet 100k sats** : ${r.bet || '?'}`,
    ``,
    `**Refinement needed** : ${r.refinement || '?'}`,
    ``,
    `Voir \`raw/phase_b_${r.lens_id}.md\` pour notes complètes du pool.`,
    ``,
    `---`,
    ``,
  ].join('\n')),
  ``,
  `## Synthèse de convergence`,
  ``,
  `Identifier l'idée référencée le plus souvent en THE_KILLER — c'est là où la convergence émerge. Si plusieurs agents pointent la même idée comme killer, c'est notre next spec à implémenter.`,
].join('\n');

fs.writeFileSync(path.join(OUT_DIR, 'AUDIT.md'), md);
console.log(`\n=== Audit complet : ${path.join(OUT_DIR, 'AUDIT.md')} ===`);
console.log(`Coût total : ~$${((totalIn * 15 + totalOut * 75) / 1e6).toFixed(2)}`);
console.log(`Bets OUI : ${betsOuis} / 7`);
