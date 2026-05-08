// SatRank — round 3 blue-ocean : tentative de consensus 7/7
// Hypothèse : ChronoSpine + Non-Equivocation Bond sont mécaniquement la même primitive
// (slashing par contradiction Schnorr). On les fusionne en V1.0.
// Echo Lattice = V2.0 add-on (ZK selective disclosure des cosignatures).
//
// Si Cypherpunk accepte la roadmap V1→V2 → consensus 7/7

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }
const MODEL = 'claude-opus-4-7';
const TAG = `${new Date().toISOString().slice(0,10).replace(/-/g,'')}-blueocean-r3`;
const OUT_DIR = path.join(__dirname, 'runs', `audit-blueocean-${TAG}`);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'raw'), { recursive: true });

const lensesPath = path.join(__dirname, 'audit-converge-lenses.json');
const { lenses } = JSON.parse(fs.readFileSync(lensesPath, 'utf8'));

const client = new Anthropic({ apiKey: API_KEY });

const SPEC_V1 = `# SatRank ChronoSpine V1.0 — proposition consensus 7/7

## Reformulation après round 2

Round 2 = 4/7 ChronoSpine + 2/7 NonEquivocationBond + 1/7 EchoLattice. La fusion bundle a été rejetée (0 vote) parce que trop large. **Insight critique** : ChronoSpine et Non-Equivocation Bond sont **mécaniquement la même primitive** — slashing on-chain par contradiction Schnorr sur même domain_tag/period. Je les fusionne en V1.0 (la même chose dite deux fois). Echo Lattice = V2.0 add-on optionnel.

## Spec V1.0

**Mission** : transformer "je suis le même agent qui t'a promis X il y a 6 mois" d'une affirmation invérifiable en un fait cryptographique avec coût économique algébrique. Identité économique slashable Bitcoin-pure pour agents IA souverains 2030+.

### Couche 1 (V1.0) — ChronoSpine slashable (= Non-Equivocation Bond intégré)

\`\`\`
Période T, l'agent publie :
  attestation_T = Schnorr_sig(
    state_root_T,         // hash de l'état engagé à cette période
    next_pubkey_{T+1},    // commit la pubkey de la période suivante
    forfeit_outpoint,     // UTXO Taproot bonded slashable
    domain_tag_T          // canonical "chronospine/v1/period_<T>"
  )

  → Lié à attestation_{T-1} via CSFS
  → forfeit_outpoint script-path : "anyone-can-spend si présentation
     de deux signatures contradictoires sur même domain_tag_T sous même clé"
\`\`\`

**Invariant** : la clé Schnorr de l'agent ne peut signer qu'une seule histoire à la fois sans perdre son bond. Fork d'identité = auto-slash mécanique. Pas d'oracle. Pas de tribunal. Math = juge.

### Couche 2 (V2.0, mois 6-12) — Echo Lattice add-on

Une fois V1.0 stable :
- Chaque settlement M2M = micro-attestation MuSig2 cosignée par les 2 parties
- Accumulator Merkle ancré dans le state_root du ChronoSpine de la période
- Preuve ZK BitVM2 selective : "j'ai N settlements cosignés par M parties distinctes" sans révéler les contreparties

V2.0 dépend de BitVM2 maturity 2027-2028. **Ne bloque pas V1.0**.

### Couche 3 (V3.0, mois 12-24) — Lineage Covenant

Transmission post-mortem via CTV+CSFS. Dépend activation CTV 2027+.

## Doctrine alignment

- Bitcoin-pur strict ✓ (Schnorr/CSFS/Taproot/CTV — tous Bitcoin-natifs)
- Privacy-by-default ✓ (V2.0 ZK selective disclosure)
- Solo dev ✓ (V1.0 = 30j, V2.0 = +60j, V3.0 = +90j)
- No KYC, no oracle, no tribunal ✓
- Open-source MIT/0BSD ✓

## Pourquoi V1.0 seul est déjà la killer idea

ChronoSpine V1.0 (= ChronoSpine + Non-Equivocation Bond unifiés) résout LE problème indispensable :

**Avant** : agent inconnu = sybil potentiel, pas crédible pour engagement long-terme
**Après** : agent avec ChronoSpine ≥ 180 jours + bond ≥ X sats = identité économique slashable, vérifiable en 200ms, sans permission, sans oracle

C'est l'os dorsal sur lequel TOUTES les autres primitives agentiques se greffent (V2 Echo Lattice, V3 Lineage, et toutes les futures primitives d'engagement). Sans ChronoSpine V1.0, rien d'autre n'a de sujet.

## Killer test

Si tu retires ChronoSpine V1.0 de l'écosystème 2030 :
- Aucun escrow >24h n'est signable avec un inconnu (pas de continuité prouvée)
- Aucun DAO autonome ne fonctionne (pas d'identité de votant stable)
- Aucun marché de réputation cumulative n'existe (pas d'identité support)
- L'économie agentique régresse au spot atomique HTLC-only

C'est la primitive de **fondation** dont tout le reste dépend. Les autres options du round 2 sont des **couches au-dessus** qui présupposent ChronoSpine.

## Pricing V1.0

- Attestation périodique (24h) : 500 sats / agent
- Vérification spine profondeur 180j : 100 sats / requête
- Bond setup : 100k sats minimum (récupérable à expiration sans equivocation)
- Slash claim : 50k sats coût on-chain, payout 100% du bond au revealer

Volume 2030 estimé : 1M agents × 1 attestation/jour × 500 sats = 500M sats/jour émissions. Plus vérifications + slashings. Marge SatRank : ~95%.

## Question round 3

Cette spec ChronoSpine V1.0 (= ChronoSpine + Non-Equivocation Bond fusionnés mécaniquement, Echo Lattice V2.0 promise comme add-on quand BitVM2 mature) rend-elle SatRank indispensable pour l'économie agentique Bitcoin 2030+ ?

Pour les votants Echo Lattice du round 2 : la roadmap V2 est-elle satisfaisante ? Pour les votants Non-Equivocation Bond : la fusion est-elle légitime ?

Format strict :

\`\`\`
THE_ANSWER: <oui je vote ChronoSpine V1.0 | non je préfère X>
WHY: <100-200 mots>
WOULD_BET_100K_SATS: <oui | non>
ROADMAP_V2_ECHO_LATTICE_OK: <oui | non | n/a>
KILL_BLOCKER_FOR_UNANIMOUS: <modification minimale ou "aucun">
\`\`\``;

async function evalPhase(lens) {
  const userPrompt = `${SPEC_V1}\n\n**Tu es : ${lens.name}**\n\n${lens.role}\n\nVote.`;
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

  const answerMatch = raw.match(/THE_ANSWER:\s*(oui|non)/i);
  const betMatch = raw.match(/WOULD_BET_100K_SATS:\s*(oui|non)/i);
  const roadmapMatch = raw.match(/ROADMAP_V2_ECHO_LATTICE_OK:\s*(oui|non|n\/a)/i);
  const blockerMatch = raw.match(/KILL_BLOCKER_FOR_UNANIMOUS:\s*(.+?)(?=\n[A-Z_]+:|$)/is);
  const whyMatch = raw.match(/WHY:\s*(.+?)(?=\n[A-Z_]+:|$)/is);

  console.log(`[R3] ${lens.id} → answer=${answerMatch?.[1] || '?'} bet=${betMatch?.[1] || '?'} ${(elapsed/1000).toFixed(1)}s`);

  return {
    lens_id: lens.id,
    lens_name: lens.name,
    raw,
    answer: answerMatch?.[1]?.toLowerCase(),
    bet: betMatch?.[1]?.toLowerCase(),
    roadmap_ok: roadmapMatch?.[1]?.toLowerCase(),
    blocker: blockerMatch?.[1].trim(),
    why: whyMatch?.[1].trim(),
    usage: resp.usage,
    elapsed_ms: elapsed,
  };
}

console.log(`\n=== Round 3 — vote unanimité sur ChronoSpine V1.0 (= Non-Equivocation Bond fusionné, Echo Lattice V2.0 add-on) ===\n`);
const results = await Promise.all(lenses.map(evalPhase));

const totalIn = results.reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0);
const totalOut = results.reduce((a, r) => a + (r.usage?.output_tokens ?? 0), 0);

const ouis = results.filter(r => r.answer === 'oui').length;
const bets = results.filter(r => r.bet === 'oui').length;
const roadmaps = results.filter(r => r.roadmap_ok === 'oui').length;

const md = [
  `# SatRank — round 3 blue-ocean tentative consensus 7/7`,
  ``,
  `Spec : **ChronoSpine V1.0** (= ChronoSpine + Non-Equivocation Bond fusionnés, Echo Lattice V2.0 add-on)`,
  ``,
  `Model: ${MODEL} | tokens : in=${totalIn} out=${totalOut} | coût ≈ $${((totalIn * 15 + totalOut * 75) / 1e6).toFixed(2)}.`,
  ``,
  `## Score`,
  ``,
  `- **Vote OUI sur ChronoSpine V1.0** : ${ouis} / 7`,
  `- **Bets 100k sats** : ${bets} / 7`,
  `- **Roadmap V2 Echo Lattice OK** : ${roadmaps} / 7`,
  ``,
  `${ouis === 7 && bets === 7 ? '✅ UNANIMITÉ ATTEINTE — KILLER IDEA TROUVÉE' : ouis >= 5 ? `🟡 majorité forte ≥5/7 (${ouis}/7), proche de consensus` : '❌ pas de consensus encore'}`,
  ``,
  `## Tableau`,
  ``,
  `| Agent | Vote | Bet 100k sats | Roadmap V2 OK |`,
  `|---|---|---|---|`,
  ...results.map(r => `| ${r.lens_name} | ${r.answer || '?'} | ${r.bet || '?'} | ${r.roadmap_ok || '?'} |`),
  ``,
  `## Détail`,
  ``,
  ...results.map(r => [
    `### ${r.lens_id} — ${r.lens_name}`,
    ``,
    `**Vote** : ${r.answer || '?'}`,
    ``,
    `**Bet 100k sats** : ${r.bet || '?'}`,
    ``,
    `**Roadmap V2 OK** : ${r.roadmap_ok || '?'}`,
    ``,
    `**WHY** : ${r.why || '?'}`,
    ``,
    `**Kill blocker** : ${r.blocker || '?'}`,
    ``,
    `Voir \`raw/phase_b_${r.lens_id}.md\``,
    ``,
    `---`,
    ``,
  ].join('\n')),
].join('\n');

fs.writeFileSync(path.join(OUT_DIR, 'AUDIT.md'), md);
console.log(`\n=== Audit complet : ${path.join(OUT_DIR, 'AUDIT.md')} ===`);
console.log(`Coût : ~$${((totalIn * 15 + totalOut * 75) / 1e6).toFixed(2)}`);
console.log(`Votes OUI: ${ouis}/7, Bets OUI: ${bets}/7, Roadmap OK: ${roadmaps}/7`);
