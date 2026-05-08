// SatRank deep audit — "super idée + simplification" pour devenir indispensable
// dans l'économie agentique souveraine Bitcoin. Adversarial. Opus 4.7 +
// extended thinking. 4 lenses, output qualitatif (pas de schéma JSON forcé).
//
// Usage :
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/sim/audit-superidee.mjs

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }
const MODEL = process.env.AUDIT_MODEL ?? 'claude-opus-4-7';
const TAG = process.env.AUDIT_TAG ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');
const THINKING_BUDGET = Number(process.env.AUDIT_THINKING_BUDGET ?? 16000);
const MAX_TOKENS = Number(process.env.AUDIT_MAX_TOKENS ?? 24000);
const OUT_DIR = path.join(__dirname, 'runs', `audit-superidee-${TAG}`);
const RAW_DIR = path.join(OUT_DIR, 'raw');
fs.mkdirSync(RAW_DIR, { recursive: true });

const lensesPath = path.join(__dirname, 'audit-superidee-lenses.json');
const { lenses } = JSON.parse(fs.readFileSync(lensesPath, 'utf8'));

const client = new Anthropic({ apiKey: API_KEY });

const CONTEXT = `# SatRank — audit "super idée + simplification" — 2026-05-08

## Founder & vision

Founder : Romain Orsoni (FR), solo, dev = Claude Code. Identité radicale :
- **Bitcoin-pure** : aucun x402, aucun USDC, aucun EVM. Refusé 3 fois en 6 mois.
- **Sovereign** : pas de KYC, pas de compliance retrospective, pas de soumission BIP, pas de partenariats Lightning Labs / Anthropic / Coinbase.
- **Anti-usine à gaz** : "simplification, trouver la super idée, affiner notre système". Refus explicite de l'effort de standardisation cross-écosystème.
- **Vision long-terme** : "structure qu'utilisent les agents dans un avenir où Bitcoin est partout. Monnaie souveraine, agents devenus autonomes échangeant en continu. SatRank leur permet de gagner du temps et de l'argent — un outil essentiel dans ce nouveau monde."
- Travail SatRank a 1 mois (premier commit ~9 avril 2026, on est le 8 mai 2026). 23 sims, 12 phases, ~80 schémas DB, 16 outils MCP shippés.

## État technique au 8 mai 2026

- **Catalogue** : 192 endpoints L402 sur 6 sources, top 5 providers = 77%, ~50% morts à un instant t (Cloudflare 502, replay-state, 5xx).
- **Trust signal** : Bayesian p_success per-endpoint + p_e2e 5-stage (challenge/decode/paid_probe/delivery/validation). BM25 + LLM rerank.
- **Execution** : POST /api/fulfill hold-invoice non-custodial Phase 6.
- **Insurance** : operator_bonds + ClaimEngine 1×/2×/3×/5× slashing.
- **Audit** : Ed25519 evidence bundles + DNS TXT operator attestation + AEPS daily Merkle anchor on Bitcoin L1 (OP_RETURN, cap 5 sat/vB, ~5-15k sats/mois).
- **Dispute** : Schnorr threshold attestation oracles.
- **Distribution** shippée 8 mai : npm satrank-mcp@1.0.1 + PyPI satrank==1.6.0 + Smithery satrank/mcp + MCP registry officiel dev.satrank/mcp via DNS auth sur satrank.dev.
- **AEPS** : whitepaper SatRank-interne (PAS un BIP, NE LE SERA PAS — founder rejette).

## 16 outils MCP exposés

intent, get_endpoint_score, fulfill, fulfill_evidence, mini_llm_classify, mini_llm_summarize, mini_llm_translate, aeps.daily_anchor, aeps.recent_anchors, aeps.inclusion_proof, aeps.evidence_receipt, aeps.get_dispute, aeps.list_forks, aeps.get_observations, aeps.get_multihop, verify_assertion.

## Empirique — 23 sims production-grade

| Sim | Indispensable | Useful | HARMFUL | pay_2xx | "no" votes |
|-----|--------------|--------|---------|---------|------------|
| 13  | 1            | 3      | 3       | 62.5%   | 6          |
| 18  | 1            | 1      | 0       | 37.5%   | 6          |
| 23  | 1            | 5      | 0       | 56.1%   | 5          |

**1 seul persona indispensable depuis 6 sims consécutives** : a10 RegRetentionAI (compliance/regulator). Cet axe a été REJETÉ par le founder ("EU AI Act communiste, je m'en fous").

## Audit précédent 2026-05-08 (6 lenses Opus indépendantes, convergent)

3 vérités convergentes :
1. **a10 = template, pas exception** : passage *information → attestation* = unique axe d'indispensabilité. Le reste est commodifiable en 200 lignes Python.
2. **Self-loop épistémologique** : "23 sims = benchmark internal-loop où l'unique utilisateur récurrent est Romain lui-même, déguisé en 10 personas, payant ses propres endpoints avec ses propres sats".
3. **Bitcoin-pure appliqué à 1/16 outils** : seul \`verify_assertion\` est Bitcoin-grade pur. \`mini_llm_*\` viole 3 propriétés Bitcoin (no trusted intermediaries, deterministic state, censorship resistance).

Audit précédent a proposé 6 actions (AEPS-Cashu Receipts, Counterparty Risk Score, PR upstream MCP spec, etc.) — le founder a rejeté l'angle compliance et l'angle BIP. Demande maintenant **la super idée + simplification radicale**.

## Concurrence existentielle (mai 2026)

- **x402 Coinbase USDC EVM** : 100× SatRank's volume, simpler ergonomics, well-funded
- **Lightning Labs Taproot Assets** : USDT-on-LN live mars 2026
- **Anthropic MCP** : peut bundle un payment any quarter
- **Observer Protocol** : concurrent direct trust+audit, pas encore shipped
- **Cashu/fedimint** : ecash settlement L1-anchored
- **Nostr DVMs (NIP-90)** : data vending machines payment-native

## Ce que le founder REFUSE explicitement

- Soumission BIP / standard externe / jeu de standardisation
- Compliance retrospective, EU AI Act, SOC2, audit régulé entreprise
- x402 / USDC / EVM / stablecoin non-Bitcoin
- Partenariats Lightning Labs / Anthropic / Coinbase (perte de souveraineté)
- Usine à gaz : prolifération d'outils, schémas, endpoints
- Cohabitation : "remplace directement, pas d'endpoint parallèle"

## Ce qu'il VEUT

- 1 super idée Bitcoin-pure sovereign
- Simplification radicale du produit actuel
- Indispensabilité dans l'économie agentique future M2M où Bitcoin est partout
- Volume cumulatif (micropaiements en nombre)
- Defensibility par construction cryptographique (pas par exécution speed)
- Fork-resistance via volume historique L1-anchored

## Doctrine du test d'acceptance d'une feature

"Un fork qui démarre demain peut-il honorer ce que SatRank émet aujourd'hui ?" Si oui, c'est de l'engineering d'index, pas SatRank. Tout outil qui ne produit pas un artefact contresignable contre Bitcoin L1 est commodifiable.

---

# Ta mission

Tu es un auditeur adversarial Opus 4.7 avec extended thinking 16k. Tu vas répondre à UNE lens posée plus bas. Réponse en français. Réponds avec rigueur extrême — pas de hand-waving, pas de "leverage AI", pas de pitch marketing. Romain a 1 mois sur ce produit et veut un signal clair, pas une compilation polie.

**Format de sortie attendu** : prose claire en français, structurée par les sous-questions de la lens. Si la lens demande des chiffres, donne-les. Si elle demande un score, score. Si elle demande une spec, écris-la complète. Pas plus de 1500 mots par lens.

L'audit sera lu directement par Romain — il agira sur tes recommandations dans les 7 jours.`;

async function callLens(lens) {
  const userPrompt = `## Lens ${lens.id} — ${lens.name}\n\n${lens.question}`;

  const startedAt = Date.now();
  let resp;
  try {
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      system: CONTEXT,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (e) {
    return { lens_id: lens.id, error: e.message, raw_text: '' };
  }

  const elapsed = Date.now() - startedAt;
  const textBlocks = (resp.content ?? []).filter(b => b.type === 'text').map(b => b.text);
  const raw = textBlocks.join('\n\n');
  fs.writeFileSync(path.join(RAW_DIR, `${lens.id}.md`), `# ${lens.id} — ${lens.name}\n\n${raw}\n`);
  console.log(`✓ ${lens.id} done in ${(elapsed / 1000).toFixed(1)}s — ${raw.length} chars`);
  return { lens_id: lens.id, lens_name: lens.name, raw_text: raw, usage: resp.usage, elapsed_ms: elapsed };
}

console.log(`Launching ${lenses.length} lenses in parallel — model=${MODEL} thinking=${THINKING_BUDGET}`);
const results = await Promise.all(lenses.map(callLens));

const totalIn = results.reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0);
const totalOut = results.reduce((a, r) => a + (r.usage?.output_tokens ?? 0), 0);
const totalThinking = results.reduce((a, r) => a + (r.usage?.cache_creation_input_tokens ?? 0), 0);

const md = [
  `# SatRank — audit super idée + simplification — ${TAG}`,
  ``,
  `Model: ${MODEL}, thinking budget: ${THINKING_BUDGET}. ${results.length} lenses parallèles.`,
  `Total tokens : in=${totalIn} out=${totalOut} thinking_creation=${totalThinking}.`,
  ``,
  `Coût estimé Opus 4.7 : ~$${((totalIn * 15 + totalOut * 75) / 1e6).toFixed(2)} (input $15/Mtok output $75/Mtok).`,
  ``,
  `## Sommaire`,
  ``,
  ...results.map(r => `- [${r.lens_id} — ${r.lens_name}](#${r.lens_id.toLowerCase()})`),
  ``,
  `---`,
  ``,
  ...results.map(r => `## ${r.lens_id} — ${r.lens_name}\n\n${r.raw_text || `[ERROR: ${r.error}]`}\n\n---\n`),
].join('\n');

fs.writeFileSync(path.join(OUT_DIR, 'AUDIT.md'), md);
console.log(`\nAudit complete : ${path.join(OUT_DIR, 'AUDIT.md')}`);
console.log(`Total in=${totalIn} out=${totalOut} thinking=${totalThinking}`);
