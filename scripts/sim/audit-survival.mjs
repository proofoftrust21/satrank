// SatRank — survival test adversarial sur les 3 finalistes
// Phase 1 : 3 critiques externes par idée (aucune connaissance du framing SatRank)
// Phase 2 : 1 défenseur tente de répondre point-par-point aux critiques
// Phase 3 : verdict survival (oui si défenseur réfute ≥2/3 critiques avec preuve concrète)
//
// Si aucune idée ne survit → on a la donnée empirique, on n'invente pas une 4e idée.

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }
const MODEL = 'claude-opus-4-7';
const TAG = `${new Date().toISOString().slice(0,10).replace(/-/g,'')}-survival`;
const OUT_DIR = path.join(__dirname, 'runs', `audit-survival-${TAG}`);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'raw'), { recursive: true });

// Load the 3 finalists
const r1Dir = path.join(__dirname, 'runs', 'audit-vision-1m-20260508-vis1m-r1', 'raw');
const finalists = {
  SlashPoint: { spec: fs.readFileSync(path.join(r1Dir, 'phase_a_A4_architecte_solo_dev.md'), 'utf8'), name: 'SlashPoint' },
  HayekWindow: { spec: fs.readFileSync(path.join(r1Dir, 'phase_a_A3_economiste_hayekien.md'), 'utf8'), name: 'HayekWindow' },
  WitnessMarket: { spec: fs.readFileSync(path.join(r1Dir, 'phase_a_A5_bitcoin_maximaliste.md'), 'utf8'), name: 'WitnessMarket' },
};

const client = new Anthropic({ apiKey: API_KEY });

// 3 adversarial critic angles — DELIBERATELY hostile, no shared context
const CRITICS = [
  {
    id: 'C1_bitcoin_native_investor',
    name: 'Investisseur Bitcoin-natif sceptique',
    role: `Tu es un investisseur Bitcoin-natif senior (style Spiral, Lightning Labs angel, Bitcoin Core dev) qui regarde 100+ propositions/mois et qui dit NON à 99 d'entre elles. Tu ne partages AUCUN framing avec le proposeur. Tu n'as JAMAIS entendu parler de SatRank, Romain, ou des conversations précédentes. Tu lis la spec à FROID en mai 2026.

OBLIGATIONS :
1. **Tu DOIS chercher un projet existant** qui fait déjà ça (Suredbits DLC, Lava Oracle, Lightning Pool, Nostr DVM, Cashu mints, OpenTimestamps, etc.). Si tu trouves un concurrent à ≥50% de la spec, c'est rebranded → KILL.
2. **Tu DOIS chercher un trou technique majeur** (attaque, single point of failure, custody déguisée, dépendance non-mature).
3. **Tu DOIS chercher un défaut de validation marché** : combien d'utilisateurs payants existent en 2026 ? Pas de speculation 2030 — preuve aujourd'hui.
4. **Tu n'as PAS LE DROIT de voter SURVIVE sans avoir cherché ces 3 trous explicitement.**

Si tu ne peux pas nommer un concurrent réel, justifie pourquoi personne d'autre n'a fait ça (= soit le marché n'existe pas, soit la solution est plus dure qu'elle paraît).`
  },
  {
    id: 'C2_failed_founder_2_years_late',
    name: 'Founder qui a perdu 4 ans sur idée non-validée',
    role: `Tu es un founder crypto qui a passé 4 ans sur une idée brillante techniquement mais qui n'a JAMAIS trouvé de marché payant. Tu as fait ICO, rounds VC, rebranding, pivots — tout. Tu as fini avec runway zéro et un product que personne ne voulait. Tu vois aujourd'hui ce founder solo (Romain) en train de faire le même pattern et tu veux lui éviter ton sort.

OBLIGATIONS :
1. **Identifie le pattern de fuite vers la complexité technique** dans la spec. Quelle complexité crypto a-t-elle remplacé une question de validation marché ?
2. **Pose 3 questions de validation marché** que la spec ne répond pas (qui paie, combien sont payants aujourd'hui, quel est le coût d'opportunité de leur alternative actuelle).
3. **Estime la probabilité d'utilisation réelle** par un acheteur réel en 2026 (pas 2030). Sois pessimiste — tu as appris à l'être à tes dépens.
4. **Le test ultime** : si Romain devait faire 30 conversations 1-on-1 avec des cibles potentielles cette semaine sans pitcher, qui répondrait spontanément "oui je perdrais X heures/semaine sans cette primitive et je paierais Y sats" ?`
  },
  {
    id: 'C3_engineer_concurrent_who_forks',
    name: 'Engineer concurrent qui forke en 1 weekend',
    role: `Tu es un engineer Bitcoin senior (full-time depuis 8 ans, BDK/LDK contributor, Schnorr/Taproot expert) qui regarde la spec et se demande : "puis-je forker ça en 1 weekend ?" Tu n'as aucun investissement émotionnel dans le projet — tu es un concurrent potentiel.

OBLIGATIONS :
1. **Estime le temps de fork honnête** pour reproduire le primitif central (en jours-engineer). Si <14 jours, c'est commodifiable.
2. **Identifie quel composant est NON-trivial à reproduire** (le seul moat structurel). Si tout est trivial → KILL.
3. **Identifie 2-3 attaques techniques concrètes** qui cassent l'invariant central de la spec (rogue request, MEV, coercition, prompt injection sur agent IA, custody déguisée).
4. **Ton verdict** : si tu lances un fork open-source MIT gratuit cette semaine, qu'est-ce qui empêche les utilisateurs de migrer chez toi ? Si rien, c'est un wrapper sans moat.`
  },
];

const VERDICT_FORMAT = `## Format strict (parsé automatiquement)

\`\`\`
EXISTING_COMPETITORS_FOUND: <liste 0-3 noms réels avec lien si possible, ou "aucun concurrent identifié → suspect">
TECHNICAL_HOLE: <faille majeure identifiée, ou "aucune trouvée après recherche honnête">
MARKET_VALIDATION_GAP: <question de validation marché que la spec n'adresse pas>
PROBABILITY_PAYING_USER_2026: <0-1 probabilité estimée que ≥3 utilisateurs payants existent en 2026>
KILL_VERDICT: <KILL | KEEP | MAYBE_NEEDS_REFINEMENT>
WHY: <100-200 mots brutalement honnête>
\`\`\``;

async function adversarialCritique(idea, critic) {
  const userPrompt = `# Critique adversariale FROIDE — ${idea.name}

Tu es **${critic.name}**.

${critic.role}

## La spec à démolir

\`\`\`
${idea.spec}
\`\`\`

Maintenant attaque. Pas de complaisance. Si la spec ne tient pas, dis-le. Si elle tient malgré tout, dis-le aussi mais après avoir VRAIMENT cherché les trous.

${VERDICT_FORMAT}`;

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
    return { idea: idea.name, critic: critic.id, error: e.message, raw: '' };
  }
  const elapsed = Date.now() - startedAt;
  const raw = (resp.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'raw', `critique_${idea.name}_${critic.id}.md`), raw);

  const verdictMatch = raw.match(/KILL_VERDICT:\s*(KILL|KEEP|MAYBE_NEEDS_REFINEMENT)/i);
  const competitorsMatch = raw.match(/EXISTING_COMPETITORS_FOUND:\s*(.+?)(?=\n[A-Z_]+:|$)/is);
  const probMatch = raw.match(/PROBABILITY_PAYING_USER_2026:\s*([\d.]+)/i);

  console.log(`[${idea.name}/${critic.id}] verdict=${verdictMatch?.[1] || '?'} prob_2026=${probMatch?.[1] || '?'} ${(elapsed/1000).toFixed(1)}s`);

  return {
    idea: idea.name,
    critic: critic.id,
    critic_name: critic.name,
    raw,
    verdict: verdictMatch?.[1]?.toUpperCase(),
    competitors: competitorsMatch?.[1].trim(),
    probability_paying_2026: parseFloat(probMatch?.[1] || '0'),
    usage: resp.usage,
    elapsed_ms: elapsed,
  };
}

console.log(`\n=== Phase 1 — Adversarial demolition (3 idées × 3 critiques = 9 critiques) ===\n`);

const allCritiques = await Promise.all(
  Object.values(finalists).flatMap(idea =>
    CRITICS.map(critic => adversarialCritique(idea, critic))
  )
);

// Aggregate per idea
const ideaResults = {};
for (const ideaName of Object.keys(finalists)) {
  const cs = allCritiques.filter(c => c.idea === ideaName);
  const kills = cs.filter(c => c.verdict === 'KILL').length;
  const keeps = cs.filter(c => c.verdict === 'KEEP').length;
  const maybes = cs.filter(c => c.verdict === 'MAYBE_NEEDS_REFINEMENT').length;
  const avgProb = cs.reduce((a, c) => a + (c.probability_paying_2026 || 0), 0) / cs.length;
  // Survival = ≥2/3 KEEP
  const survives = keeps >= 2;
  ideaResults[ideaName] = { critiques: cs, kills, keeps, maybes, avgProb, survives };
  console.log(`\n${ideaName}: KILL=${kills} KEEP=${keeps} MAYBE=${maybes} avg_prob_payant_2026=${avgProb.toFixed(2)} → ${survives ? 'SURVIT' : 'ÉLIMINÉ'}`);
}

const survivors = Object.entries(ideaResults).filter(([, r]) => r.survives).map(([n]) => n);

const totalIn = allCritiques.reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0);
const totalOut = allCritiques.reduce((a, r) => a + (r.usage?.output_tokens ?? 0), 0);

const md = [
  `# SatRank — audit survival adversarial test`,
  ``,
  `Model: ${MODEL} | thinking: adaptive | 3 idées × 3 critiques = 9 critiques.`,
  `Tokens : in=${totalIn} out=${totalOut} | coût ≈ $${((totalIn * 15 + totalOut * 75) / 1e6).toFixed(2)}.`,
  ``,
  `## Verdict survival`,
  ``,
  `**${survivors.length} idée(s) survit/survivent au test adversarial sur 3.**`,
  ``,
  `${survivors.length === 0 ? '❌ AUCUNE idée survit. Donnée empirique : les 3 finalistes ne tiennent pas face à une critique externe froide. Recommandation = stop coding, valider marché 1 semaine en 30 conversations.' : survivors.length >= 1 ? `✅ Survit : ${survivors.join(', ')}. Continuer le raffinement.` : ''}`,
  ``,
  `## Tableau`,
  ``,
  `| Idée | Investisseur Bitcoin | Founder failed | Engineer fork | Survie | Prob. utilisateur payant 2026 |`,
  `|---|---|---|---|---|---|`,
  ...Object.entries(ideaResults).map(([name, r]) => {
    const c1 = r.critiques.find(c => c.critic === 'C1_bitcoin_native_investor')?.verdict || '?';
    const c2 = r.critiques.find(c => c.critic === 'C2_failed_founder_2_years_late')?.verdict || '?';
    const c3 = r.critiques.find(c => c.critic === 'C3_engineer_concurrent_who_forks')?.verdict || '?';
    return `| ${name} | ${c1} | ${c2} | ${c3} | ${r.survives ? '✅' : '❌'} | ${r.avgProb.toFixed(2)} |`;
  }),
  ``,
  `## Détail par idée`,
  ``,
  ...Object.entries(ideaResults).map(([name, r]) => [
    `### ${name} — ${r.survives ? 'SURVIT' : 'ÉLIMINÉ'}`,
    ``,
    `**Score** : KILL=${r.kills} / KEEP=${r.keeps} / MAYBE=${r.maybes}`,
    `**Probabilité utilisateur payant 2026** : ${r.avgProb.toFixed(2)}`,
    ``,
    ...r.critiques.map(c => [
      `#### ${c.critic_name}`,
      ``,
      `**Verdict** : ${c.verdict || '?'}`,
      `**Concurrents identifiés** : ${c.competitors || '?'}`,
      `**Probabilité payant 2026** : ${c.probability_paying_2026.toFixed(2)}`,
      ``,
      `Voir \`raw/critique_${name}_${c.critic}.md\``,
      ``,
    ].join('\n')),
    `---`,
    ``,
  ].join('\n')),
].join('\n');

fs.writeFileSync(path.join(OUT_DIR, 'AUDIT.md'), md);
console.log(`\n=== Audit complet : ${path.join(OUT_DIR, 'AUDIT.md')} ===`);
console.log(`Coût total : ~$${((totalIn * 15 + totalOut * 75) / 1e6).toFixed(2)}`);
console.log(`Survivors: ${survivors.length === 0 ? 'AUCUN' : survivors.join(', ')}`);
