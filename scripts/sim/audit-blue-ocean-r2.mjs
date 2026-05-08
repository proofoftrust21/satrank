// SatRank — round 2 blue-ocean : head-to-head 4 finalistes individuelles + 1 fusion proposée
// Si 7/7 sur la fusion → killer idea trouvée
// Sinon → output, max 3 rounds total

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }
const MODEL = 'claude-opus-4-7';
const TAG = `${new Date().toISOString().slice(0,10).replace(/-/g,'')}-blueocean-r2`;
const OUT_DIR = path.join(__dirname, 'runs', `audit-blueocean-${TAG}`);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'raw'), { recursive: true });

const lensesPath = path.join(__dirname, 'audit-converge-lenses.json');
const { lenses } = JSON.parse(fs.readFileSync(lensesPath, 'utf8'));

const r1Dir = path.join(__dirname, 'runs', 'audit-blueocean-20260508-blueocean', 'raw');

const client = new Anthropic({ apiKey: API_KEY });

// Read the relevant ideas
const devilSpec = fs.readFileSync(path.join(r1Dir, 'phase_a_A1_devil_advocate.md'), 'utf8');
const architecteSpec = fs.readFileSync(path.join(r1Dir, 'phase_a_A4_architecte_solo_dev.md'), 'utf8');
const hayekSpec = fs.readFileSync(path.join(r1Dir, 'phase_a_A3_economiste_hayekien.md'), 'utf8');

const FUSION_PROPOSAL = `## OPTION FUSION : SatRank Spine — Identité économique agentique souveraine intégrée

**Hypothèse** : ChronoSpine + Echo Lattice + Non-Equivocation Bond sont les **3 couches complémentaires** d'une primitive unique d'identité économique agentique. Aucune ne tient seule. Fusionnées, elles forment LA primitive manquante de l'économie agentique 2030+.

### Architecture unifiée

\`\`\`
┌──────────────────────────────────────────────────────┐
│  SatRank Spine — Souveraineté agentique cryptographique  │
├──────────────────────────────────────────────────────┤
│                                                      │
│  Couche 1 — ChronoSpine (squelette temporel)         │
│  • Attestation Schnorr engageante chaque période T   │
│  • Liée par CSFS à période T-1                       │
│  • Tout fork d'identité = auto-slash                 │
│  • Vérification O(log n) via Merkle-skiplist         │
│                                                      │
│  Couche 2 — Echo Lattice (chair cosignée)            │
│  • Chaque settlement M2M = micro-attestation MuSig2  │
│  • Accumulator Merkle local                          │
│  • Preuve ZK BitVM2 selective disclosure             │
│  • "N settlements cosignés par M parties distinctes" │
│                                                      │
│  Couche 3 — Non-Equivocation Bond (Nash-stable)      │
│  • Bond Taproot slashable cryptographiquement        │
│  • Deux racines lattice contradictoires = slash      │
│  • Schnorr equivocation-as-proof                     │
│  • Pas d'oracle, math = juge                         │
│                                                      │
└──────────────────────────────────────────────────────┘
\`\`\`

### Job-to-be-done unifié

Un agent IA 2030 rencontre 100+ inconnus/jour. Pour chacun :
1. Il vérifie la **ChronoSpine** de l'inconnu → continuité d'identité depuis N mois
2. Il demande une preuve **Echo Lattice** ZK → "tu as ≥M settlements cosignés réels"
3. Il vérifie le **Non-Equivocation Bond** actif → l'inconnu a du capital slashable
4. Si tout OK, il transige sans humain, sans oracle, sans permission

Sans cette suite intégrée, **l'onboarding M2M anonyme à 1M agents est mathématiquement impossible**.

### Pricing intégré

- ChronoSpine attestation périodique : 500 sats / 24h
- Echo Lattice cosignature M2M : 50 sats / settlement
- Echo Lattice ZK proof generation : 5000 sats / preuve
- Non-Equivocation Bond setup : 100k sats minimum (récupérable)
- ChronoSpine + Lattice anchor on-chain quotidien : amorti sur ~10k attestations
- Vérification (côté contrepartie) : 100 sats / lookup ChronoSpine, 1000 sats / vérif ZK

Volume 2030 estimé : 1M agents × 5 vérifications/jour × 100 sats = 500M sats/jour vérifications. Plus émissions+anchors.

### Pourquoi indispensable comme bundle (pas séparées)

- ChronoSpine seule = "je suis la même clé" mais aucune valeur économique cosignée → lui-fabricable
- Echo Lattice seule = preuve cosignée mais pas de continuité temporelle → un agent peut oublier ses cosignatures perdues
- Bond seul = capital lockable mais pas relié à l'historique → coût d'opportunité sans signal
- **Les 3 ensemble = identité économique souveraine cryptographique complète**

### Doctrine alignment

Bitcoin-pur strict : Schnorr/MuSig2/Taproot/CSFS/CTV/BitVM2. Pas de KYC. Pas d'oracle. Pas de tribunal. Math = juge. Privacy via ZK selective disclosure (Hughes verbatim). Open-source MIT obligatoire.

### Shippability (solo dev)

- ChronoSpine seule : 30j
- Echo Lattice seule : 60j (BitVM2 ZK circuits)
- Non-Equivocation Bond seul : 30j
- **Bundle complet** : 90-120j pour V1.0 minimum viable, V2.0 6 mois.
- Dépendance forte sur CTV/CSFS activation 2027+ pour l'auto-slash mécanique. Avant activation, version sans-slash-mécanique mais slash via convention SDK + namespace canonique.

### Killer test

Si tu retires ce bundle de l'économie agentique 2030, l'onboarding inconnu-vers-inconnu devient impossible. Soit l'agent doxx (mort de la privacy), soit il s'appuie sur une autorité (mort de la souveraineté), soit il retombe à du spot atomique sans engagements long-terme (régression économique). Aucune alternative Bitcoin-pure existe pour cette fonction. Catégorie nouvelle : **proof-of-cosigned-anchored-temporally-bonded-economic-identity**.`;

const ROUND2_CONTEXT = `# Round 2 head-to-head — choisir LA killer idea blue-ocean

Round 1 brainstorm visionnaire 2030+ a produit 7/7 bets 100k sats répartis sur 4 idées :
- **Echo Lattice** (Devil's advocate IDEA_1) — proof-of-cosigned-economic-past with ZK
- **Non-Equivocation Bond** (Devil's advocate IDEA_3) — single-history invariant Schnorr
- **ChronoSpine** (Architecte IDEA_1) — continuité d'identité économique
- **Praxeo Futures** (Hayek IDEA_1) — futures sur productivité agentique

Plus une **option fusion** que je propose ci-dessous : SatRank Spine = les 3 plus convergents intégrés.

## Specs des 4 finalistes individuels

### 1. Echo Lattice (Devil IDEA_1)

${devilSpec.match(/IDEA_1:[\s\S]*?(?=IDEA_2:)/)?.[0] || ''}

### 2. Non-Equivocation Bond (Devil IDEA_3)

${devilSpec.match(/IDEA_3:[\s\S]*?(?=IDEA_4:|---)/)?.[0] || ''}

### 3. ChronoSpine (Architecte IDEA_1)

${architecteSpec.match(/IDEA_1:[\s\S]*?(?=IDEA_2:)/)?.[0] || ''}

### 4. Praxeo Futures (Hayek IDEA_1)

${hayekSpec.match(/IDEA_1:[\s\S]*?(?=IDEA_2:)/)?.[0] || ''}

### 5. ⭐ FUSION : SatRank Spine

${FUSION_PROPOSAL}

## Cadre rappel

- Pure vision 2030+, pas validation 2026
- Bitcoin-pur strict, doctrine immuable
- Indispensable pour l'économie agentique 1M+ agents
- Pas un wrapper sur primitive existante

## Ta mission round 2

**Choisis 1 seule** parmi les 5 options (4 individuelles + fusion). Sois adversarial.

Format strict :

\`\`\`
SCORES:
  EchoLattice: indisp=<n> doctrine=<n> ship=<n> vision=<n>
  NonEquivocationBond: indisp=<n> doctrine=<n> ship=<n> vision=<n>
  ChronoSpine: indisp=<n> doctrine=<n> ship=<n> vision=<n>
  PraxeoFutures: indisp=<n> doctrine=<n> ship=<n> vision=<n>
  SatRankSpineFusion: indisp=<n> doctrine=<n> ship=<n> vision=<n>

THE_ONE: <EchoLattice | NonEquivocationBond | ChronoSpine | PraxeoFutures | SatRankSpineFusion>
WHY: <100-200 mots>
WOULD_BET_100K_SATS_ON_THE_ONE: <oui | non>
WHY_BET: <1-2 phrases>
\`\`\`

## Ton angle métier`;

async function evalPhase(lens) {
  const userPrompt = `${ROUND2_CONTEXT}\n\n**Tu es : ${lens.name}**\n\n${lens.role}\n\nChoisis LE seul.`;
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

  const oneMatch = raw.match(/THE_ONE:\s*(EchoLattice|NonEquivocationBond|ChronoSpine|PraxeoFutures|SatRankSpineFusion)/i);
  const betMatch = raw.match(/WOULD_BET_100K_SATS_ON_THE_ONE:\s*(oui|non)/i);
  const whyMatch = raw.match(/WHY:\s*(.+?)(?=\n[A-Z_]+:|$)/is);

  console.log(`[R2] ${lens.id} → ${oneMatch?.[1] || '?'} bet=${betMatch?.[1] || '?'} ${(elapsed/1000).toFixed(1)}s`);

  return {
    lens_id: lens.id,
    lens_name: lens.name,
    raw,
    the_one: oneMatch?.[1],
    bet: betMatch?.[1]?.toLowerCase(),
    why: whyMatch?.[1].trim(),
    usage: resp.usage,
    elapsed_ms: elapsed,
  };
}

console.log(`\n=== Round 2 — head-to-head 5 options (4 individuelles + 1 fusion) ===\n`);
const results = await Promise.all(lenses.map(evalPhase));

const totalIn = results.reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0);
const totalOut = results.reduce((a, r) => a + (r.usage?.output_tokens ?? 0), 0);

const counts = { EchoLattice: 0, NonEquivocationBond: 0, ChronoSpine: 0, PraxeoFutures: 0, SatRankSpineFusion: 0 };
for (const r of results) {
  if (r.the_one) counts[r.the_one] = (counts[r.the_one] || 0) + 1;
}
const winner = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
const betsOuiOnWinner = results.filter(r => r.the_one === winner[0] && r.bet === 'oui').length;
const totalBets = results.filter(r => r.bet === 'oui').length;

const md = [
  `# SatRank — round 2 blue-ocean head-to-head`,
  ``,
  `Model: ${MODEL} | tokens : in=${totalIn} out=${totalOut} | coût ≈ $${((totalIn * 15 + totalOut * 75) / 1e6).toFixed(2)}.`,
  ``,
  `## Vote distribution`,
  ``,
  `- **EchoLattice** : ${counts.EchoLattice} / 7`,
  `- **NonEquivocationBond** : ${counts.NonEquivocationBond} / 7`,
  `- **ChronoSpine** : ${counts.ChronoSpine} / 7`,
  `- **PraxeoFutures** : ${counts.PraxeoFutures} / 7`,
  `- **SatRankSpineFusion** : ${counts.SatRankSpineFusion} / 7`,
  ``,
  `**WINNER : ${winner[0]} (${winner[1]} votes)**`,
  `**Bets OUI : ${totalBets}/7 — sur le winner : ${betsOuiOnWinner}/${winner[1]}**`,
  ``,
  `${winner[1] === 7 ? '✅ UNANIMITÉ — killer idea trouvée' : winner[1] >= 5 ? '🟡 majorité forte ≥5/7' : '❌ pas de consensus'}`,
  ``,
  `## Tableau`,
  ``,
  `| Agent | THE_ONE | Bet 100k sats |`,
  `|---|---|---|`,
  ...results.map(r => `| ${r.lens_name} | **${r.the_one || '?'}** | ${r.bet || '?'} |`),
  ``,
  `## Détail`,
  ``,
  ...results.map(r => [
    `### ${r.lens_id} — ${r.lens_name}`,
    ``,
    `**THE_ONE** : ${r.the_one || '?'}`,
    ``,
    `**WHY** : ${r.why || '?'}`,
    ``,
    `**Bet 100k sats** : ${r.bet || '?'}`,
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
console.log(`Distribution : ${JSON.stringify(counts)}`);
console.log(`Winner: ${winner[0]} (${winner[1]} votes), bets OUI total: ${totalBets}/7`);
