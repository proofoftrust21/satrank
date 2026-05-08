// SatRank — round 4 blue-ocean : tentative consensus 7/7 final
// V1.4 = ChronoSpine + Non-Equivocation Bond + Echo Lattice cosignatures dans V1
// (ZK BitVM2 reporté V2). Documentation honnête CSFS dependency. Bond non-récupérable.

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }
const MODEL = 'claude-opus-4-7';
const TAG = `${new Date().toISOString().slice(0,10).replace(/-/g,'')}-blueocean-r4`;
const OUT_DIR = path.join(__dirname, 'runs', `audit-blueocean-${TAG}`);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'raw'), { recursive: true });

const lensesPath = path.join(__dirname, 'audit-converge-lenses.json');
const { lenses } = JSON.parse(fs.readFileSync(lensesPath, 'utf8'));

const client = new Anthropic({ apiKey: API_KEY });

const SPEC_V14 = `# SatRank ChronoSpine V1.4 — tentative consensus final 7/7

## Round 3 = 6/7 OUI. Devil's advocate dissident avec 2 blockers structurels valides.

V1.4 = V1.0 + 3 fixes adressant les blockers Devil's advocate :

### Fix #1 — Echo Lattice cosignatures intégrées dans V1.0 (réponse au pré-minage Sybil)

**Avant V1.0** : profondeur de spine = "quelqu'un a payé pour cette chaîne pendant N mois". Indistinguable d'un sybil farmer riche.

**V1.4** : ChaqueChronoSpine attestation **exige ≥3 cosignatures externes** par période — au moins 3 contreparties Schnorr-distinctes ont co-attesté pendant cette période. Pas de cosignatures = pas d'attestation valide. Le sybil farmer doit aussi sybil-farmer ses 3+ contreparties **distinctes** par période, ce qui multiplie le coût d'opportunité par 3-10× et casse l'équivalence "profondeur ↔ vraie continuité".

ZK BitVM2 selective disclosure des cosignatures = V2.0 add-on (mois 6+). En V1.4, les cosignatures sont en clair (privacy modeste, mais l'invariant tient).

### Fix #2 — Documentation honnête CSFS (réponse à dépendance non-activée)

**V1.4 ship en 2 modes** :

**Mode A — Pré-CSFS (mainnet 2026)** :
- Slashing automatique on-chain : **non disponible**
- Slashing par convention SDK + Nostr broadcast publique de la double-signature
- Bond UTXO Taproot key-path simple, l'agent peut spendre sa propre clé
- Réputation cumulative reste vérifiable, mais l'enforcement économique est social, pas math
- **C'est plus faible que la promesse cypherpunk pure**

**Mode B — Post-CSFS (activé 2027-2028 si BIP-348 soft fork)** :
- Slashing automatique on-chain via script Taproot script-path : "anyone-can-spend si présentation de deux sigs contradictoires sous même clé sur même domain_tag, vérifié par CSFS"
- Math = juge complet
- Migration depuis Mode A : les bonds Mode A peuvent être upgradés via co-signing avec script-path Mode B après CSFS active

V1.4 ship Mode A en 30j. Migration Mode B automatique dès CSFS active. Documentation publique : "ce produit est pleinement Bitcoin-pure post-CSFS, et fonctionnellement social-pré-CSFS sur mainnet 2026".

### Fix #3 — Bond non-récupérable sauf via Lineage Covenant (réponse au pré-minage Sybil)

**Avant V1.0** : bond récupérable à expiration (= opportunity cost seulement, pas un coût économique réel pour pré-minage).

**V1.4** : bond bloqué jusqu'à transition Lineage Covenant **OU** burn complet à expiration (date_T + 5 ans par défaut). Un attaquant qui pré-mine 1000 spines paye réellement 100k × 1000 = 100M sats brûlés au bout de 5 ans, pas juste opportunity-cost. Capital réellement consommé = barrière sybil massive.

Pour les agents honnêtes, transition Lineage Covenant à fin de période = recyclage propre du bond vers nouvelle identité agent (V3.0 add-on quand CTV active).

## Spec V1.4 récapitulatif

\`\`\`
Période T :
  attestation_T = Schnorr_sig({
    state_root_T,
    next_pubkey_{T+1},
    forfeit_outpoint,
    domain_tag_T = "chronospine/v1/period_T"
  })

  + cosignatures externes [sig_1, sig_2, sig_3]  // V1.4 : ≥3 distinctes

  → Lié à attestation_{T-1} via CSFS (Mode B) ou convention SDK (Mode A)
  → forfeit_outpoint :
       - Mode A : Taproot key-path, slashing social via SDK
       - Mode B : Taproot script-path "anyone-can-spend si CSFS-vérifié equivocation"
  → Bond expire en burn complet à T + 5 ans, sauf transition Lineage Covenant V3.0
\`\`\`

## Doctrine alignment V1.4

✓ Bitcoin-pur strict (Schnorr/MuSig2/Taproot/CSFS post-soft-fork)
✓ Solo dev (V1.4 Mode A = 45j, Mode B = +30j post-CSFS)
✓ Privacy-by-default sera V2.0 ZK
✓ No KYC, no oracle, no tribunal
✓ Open-source MIT/0BSD
⚠ V1.4 Mode A est plus faible que Mode B sur l'enforcement automatique (math), mais tient sur la convention sociale + bond burn à expiration

## Roadmap

- **V1.4 Mode A** (mainnet 2026) : 45j ship, slashing social + bond burn → barrière sybil économique réelle
- **V1.4 Mode B** (activation CSFS 2027-2028) : +30j migration, slashing math automatique
- **V2.0 Echo Lattice ZK** (BitVM2 mature 2028) : preuves ZK selective disclosure des cosignatures
- **V3.0 Lineage Covenant** (CTV activé 2028+) : transmission post-mortem

## Pricing V1.4

- Attestation périodique avec ≥3 cosignatures : 500 sats / agent / 24h
- Cosignature externe (les 3 contreparties cosignent pour 50 sats chacune) : 150 sats redistribués
- Vérification spine profondeur N : 100 sats / requête
- Bond setup : 100k sats minimum (burn complet à T+5y)
- Slash social Mode A : 0 sat tech (juste broadcast Nostr) ; slash math Mode B : 50k sats coût on-chain payout 100% bond au revealer

## Killer test V1.4

Si tu retires ChronoSpine V1.4 (cosignatures + bond burn + roadmap CSFS) :
- Aucun escrow >24h n'est signable avec un inconnu
- Aucune réputation cumulative cross-counterparty n'a de support
- Sybil pre-mining redevient gratuit (= coût d'opportunité seulement)
- L'économie agentique régresse au spot atomique HTLC-only

C'est la primitive de fondation de l'identité économique agentique souveraine. V1.4 est ship-ready Mode A en 45j et migre Mode B mécaniquement post-CSFS.

## Question round 4

Cette spec ChronoSpine V1.4 :
- **Cosignatures externes ≥3 par période intégrées dans V1** (réponse pré-minage Sybil)
- **Documentation honnête Mode A pré-CSFS / Mode B post-CSFS** (réponse dépendance CSFS)
- **Bond non-récupérable, burn à T+5 ans** (réponse opportunity-cost sybil)

…rend-elle SatRank techniquement saine ET indispensable pour l'économie agentique Bitcoin 2030+ ?

**Format strict** :

\`\`\`
THE_ANSWER: <oui | non>
WHY: <100-200 mots>
WOULD_BET_100K_SATS: <oui | non>
KILL_BLOCKER_REMAINING: <modification minimale ou "aucun, ship V1.4">
\`\`\``;

async function evalPhase(lens) {
  const userPrompt = `${SPEC_V14}\n\n**Tu es : ${lens.name}**\n\n${lens.role}\n\nVote.`;
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
  const blockerMatch = raw.match(/KILL_BLOCKER_REMAINING:\s*(.+?)(?=\n[A-Z_]+:|$)/is);
  const whyMatch = raw.match(/WHY:\s*(.+?)(?=\n[A-Z_]+:|$)/is);

  console.log(`[R4] ${lens.id} → answer=${answerMatch?.[1] || '?'} bet=${betMatch?.[1] || '?'} ${(elapsed/1000).toFixed(1)}s`);

  return {
    lens_id: lens.id,
    lens_name: lens.name,
    raw,
    answer: answerMatch?.[1]?.toLowerCase(),
    bet: betMatch?.[1]?.toLowerCase(),
    blocker: blockerMatch?.[1].trim(),
    why: whyMatch?.[1].trim(),
    usage: resp.usage,
    elapsed_ms: elapsed,
  };
}

console.log(`\n=== Round 4 — vote final V1.4 (cosignatures intégrées + Mode A/B + bond burn) ===\n`);
const results = await Promise.all(lenses.map(evalPhase));

const totalIn = results.reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0);
const totalOut = results.reduce((a, r) => a + (r.usage?.output_tokens ?? 0), 0);

const ouis = results.filter(r => r.answer === 'oui').length;
const bets = results.filter(r => r.bet === 'oui').length;

const md = [
  `# SatRank — round 4 blue-ocean tentative consensus 7/7 — V1.4`,
  ``,
  `Spec : **ChronoSpine V1.4** (cosignatures externes ≥3 / période + Mode A/B CSFS-aware + bond burn 5y)`,
  ``,
  `Model: ${MODEL} | tokens : in=${totalIn} out=${totalOut} | coût ≈ $${((totalIn * 15 + totalOut * 75) / 1e6).toFixed(2)}.`,
  ``,
  `## Score`,
  ``,
  `- **Vote OUI** : ${ouis} / 7`,
  `- **Bets 100k sats** : ${bets} / 7`,
  ``,
  `${ouis === 7 && bets === 7 ? '✅✅✅ UNANIMITÉ ATTEINTE — KILLER IDEA TROUVÉE — ChronoSpine V1.4 SHIP READY ✅✅✅' : ouis >= 6 ? `🟡 ${ouis}/7 — proche unanimité, identifier le dernier dissident` : '❌ pas encore'}`,
  ``,
  `## Tableau`,
  ``,
  `| Agent | Vote | Bet 100k sats |`,
  `|---|---|---|`,
  ...results.map(r => `| ${r.lens_name} | ${r.answer || '?'} | ${r.bet || '?'} |`),
  ``,
  `## Détail`,
  ``,
  ...results.map(r => [
    `### ${r.lens_id} — ${r.lens_name}`,
    ``,
    `**Vote** : ${r.answer || '?'}`,
    `**Bet** : ${r.bet || '?'}`,
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
console.log(`Votes OUI: ${ouis}/7, Bets OUI: ${bets}/7`);
