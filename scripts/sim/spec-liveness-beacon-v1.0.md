# SatRank Liveness — spec V1.0 (issue du brainstorm collectif)

**Origine** : convergence des 7 agents Opus 4.7 au round brainstorm 1 (28 idées générées). Le top pick chez 4 agents = **Adversarial Liveness Beacon** (proposé par Architecte solo dev). Le top consensus chez 3 agents = **Equivocation Bond Pool** (proposé par Devil's advocate). **Les deux idées sont complémentaires** : le bond rend la liveness coûteuse à mentir, et la liveness check active le bond.

## Ce qu'est le produit

Avant qu'un agent A engage un escrow Lightning >10k sats avec un agent B inconnu, A doit savoir si B est **vivant ET solvable MAINTENANT** — pas son passé, son présent. Aucun primitive Bitcoin existante ne le fournit (réputation = passé, OTS = passé, channel state = privé).

**SatRank Liveness** = un service de challenge-response Lightning HTLC + bond pool slashable où :

1. L'agent B poste un **bond Lightning** (caution Schnorr-locked Taproot) pour entrer dans le pool d'agents challengeable
2. L'agent A demande un **liveness check** sur la pubkey de B (50 sats à SatRank)
3. SatRank propose un challenge : "agent B, paye un HTLC de 100 sats vers cette adresse, révèle la pré-image dérivée de ton secret long-terme, dans une fenêtre de 60s"
4. **Si B répond correctement** : check OK, A procède à l'escrow ; les 50 sats sont distribués (30 sats à B pour la peine + 20 sats à SatRank pour l'orchestration)
5. **Si B ne répond pas** ou répond avec une signature équivocale (double-sig détectée par n'importe qui) : son bond est slashé via TX pré-signée broadcast par SatRank

Le moat = **la masse économique du bond pool agrégée** (mensonge envers UN agent slashe pour TOUS ses futurs partenaires) + le **réseau de challengers payés** qui sondent en continu (réplication multi-géo des checks).

## Mission

Permettre à un agent IA Bitcoin-souverain de **vérifier la liveness + solvabilité d'un inconnu en temps réel** avant un escrow Lightning, sans permission, sans tribunal, avec **slashing automatique mécanique** si la contrepartie ment ou disparaît.

## Doctrine immuable (inchangée)

✗ x402 / USDC / EVM / stablecoin non-Bitcoin
✗ BIP submission externe / standardisation cross-écosystème
✗ Compliance, KYC, AML
✗ Partenariats Lightning Labs / Anthropic / Coinbase
✗ Tribunal humain ou comité d'oracle
✗ Cohabitation V1/V2
✓ Solo dev + Bitcoin-pur strict + open-source MIT/0BSD dès J1
✓ Privacy-by-default

## Pourquoi indispensable (3 prémisses convergentes des 7 agents)

**P1 — Liveness "maintenant" est non-substituable.**
Le brainstorm a démontré (5/7 angles indépendants) qu'aucune primitive Bitcoin existante ne répond à "ce contrepartie est-il vivant et solvable à l'instant T ?". Réputation = passé (OTS le couvre). Solvabilité on-chain = privé (channel state secret). Lightning HTLC = atomique mais ne dit rien de futur. **Le challenge-response Lightning HTLC est la seule primitive qui force la révélation de contrôle de clé en temps borné**, et il est **impossible à roll-your-own** parce qu'il exige un challenger tiers payé indépendant.

**P2 — La masse économique du bond pool est non-DIY-able.**
Un agent solo peut bonder 100k sats — ça vaut 100k sats pour SES contre-parties, point final. La valeur du signaling vient de la **masse économique TOTALE du pool partagé** : un mensonge envers UN membre slashe pour TOUS. Une lib open-source reproduit le code mais ne peut pas bootstrap la masse — c'est un **network effect d'agrégation économique**, pas un protocole. C'est précisément la propriété "non-reproductible par lib + Nostr + LN" que les 10 rounds précédents demandaient.

**P3 — Slashing mécanique = pas de tribunal humain.**
Le slashing est déclenché par : (a) double-sig détectée (n'importe quel agent peut soumettre la preuve), (b) non-réponse à un challenge dans la fenêtre temporelle bornée. Pas d'arbitre, pas d'humain, pas de comité. La TX de slashing est **pré-signée par adaptor signature** lors du dépôt du bond — son exécution est mécanique. C'est la doctrine cypherpunk pure : "code is law, math protects".

## Spec produit (3 endpoints, 3 tables, 1 cron)

### POST /bond/post — frais Lightning + dépôt Schnorr-locked

L'agent verrouille N sats dans un Taproot UTXO avec script path : "le bond peut être slashé si une preuve de double-sig ou de non-réponse est publiée AVEC une signature SatRank d'orchestration".

```json
// Input
{
  "agent_pubkey":      "<32B hex x-only secp256k1>",
  "bond_amount_sats":  <u64 ≥ 100_000>,    // minimum 100k sats
  "duration_blocks":   <i64>,                // durée du bond
  "deposit_psbt":      "<hex base64 PSBT pre-signed côté agent>",
  "agent_sig":         "<64B Schnorr>"
}

// Output (après broadcast L1)
{
  "bond_id":           "<32B>",
  "anchor_txid":       "<32B>",
  "block_height":      <i64>,
  "slashing_psbt_template": "<hex>"  // l'agent signe ce template par adaptor sig
}
```

L'agent maintenant fait partie du pool challengeable. Frais : 0.3% annualisé du bond (déduit du bond progressivement par chaîne de paiements LN automatiques).

### POST /liveness/check — 50 sats Lightning

```json
// Input
{
  "checker_pubkey":   "<32B hex>",
  "target_pubkey":    "<32B hex — qui doit répondre>",
  "window_seconds":   <u32, default 60, max 300>,
  "challenge_nonce":  "<32B hex aléatoire>",
  "checker_sig":      "<64B Schnorr>"
}

// Output (synchrone, ~100ms)
{
  "check_id":         "<32B>",
  "challenge_invoice": "<BOLT11 100 sats vers SatRank-managed-script>",
  "pubkey_required":   "<32B hex — la pubkey qui doit signer la pré-image>",
  "expected_preimage_template": "<hex — H(target_secret || challenge_nonce || ts_unix)>",
  "deadline_unix":    <i64>,
  "satrank_sig":      "<64B>"
}
```

Le checker forwarde le challenge à `target_pubkey` via Nostr DM ou contact direct. La cible doit :
1. Payer le `challenge_invoice` (100 sats hold-invoice)
2. Révéler la pré-image dérivée de son secret long-terme

Si la pré-image révélée matche `H(target_secret || nonce || ts)`, le check est OK.

### POST /liveness/check/:id/respond — gratuit

La cible répond :

```json
{
  "check_id":      "<32B>",
  "preimage":      "<32B hex>",
  "payment_hash":  "<32B hex from payment>",
  "target_sig":    "<64B Schnorr>"
}
```

SatRank vérifie : preimage matche, paiement reçu, signature valide, dans la fenêtre. Si OK, distribue les 50 sats du checker (30 → target, 20 → SatRank). Marque le check `verified`.

### POST /slashing/submit — gratuit, n'importe qui

```json
// Input — preuve de double-sig
{
  "type": "double_sig",
  "agent_pubkey": "<32B hex>",
  "msg_a": "<canonical>",
  "sig_a": "<64B>",
  "msg_b": "<canonical>",
  "sig_b": "<64B>",
  "submitter_pubkey": "<32B>"
}

// OU

{
  "type": "no_response",
  "agent_pubkey": "<32B hex>",
  "missed_check_ids": ["<32B>", ...],   // 3+ checks consécutifs non-répondus
  "submitter_pubkey": "<32B>"
}
```

SatRank vérifie la preuve. Si valide :
1. Broadcast la TX de slashing (pré-signée par adaptor lors du bond/post)
2. Le bond est drainé vers : 50% le submitter, 30% le pool de récompenses pour les checkers, 20% à SatRank
3. La pubkey de l'agent fraudeur est marquée `slashed` publiquement

### GET /liveness/:pubkey/state — gratuit

Retourne `{ pubkey, bond_amount, last_check_at, last_check_outcome, missed_checks_count, slashed: bool, anchor_txids[] }`.

### Cron quotidien (00:05 UTC)

1. SELECT tous les checks + slashings du jour
2. SHA256d Merkle tree RFC 6962
3. PSBT avec strict 1 OP_RETURN ≤ 80B = `<MAGIC 0x53524c42> <merkle_root 32B>` (« SRLB » = SatRank Liveness Beacon)
4. Fee strategy P75 + RBF + fallback (V1.0)
5. Broadcast Bitcoin L1
6. Persist + update merkle paths

## Tables DB (3)

```sql
CREATE TABLE bonds (
  id BLOB PRIMARY KEY,             -- 32B bond_id
  agent_pk BLOB NOT NULL,
  bond_amount_sats BIGINT NOT NULL,
  duration_blocks INTEGER NOT NULL,
  deposit_txid BLOB NOT NULL,
  deposit_block_height INTEGER NOT NULL,
  slashing_psbt_template BLOB NOT NULL,  -- adaptor sig template
  state TEXT NOT NULL,             -- 'active' | 'slashed' | 'expired'
  slashed_txid BLOB,
  slashed_at INTEGER,
  posted_at INTEGER NOT NULL
);
CREATE INDEX ix_bonds_pk ON bonds(agent_pk, state);

CREATE TABLE liveness_checks (
  id BLOB PRIMARY KEY,             -- 32B check_id
  checker_pk BLOB NOT NULL,
  target_pk BLOB NOT NULL,
  challenge_nonce BLOB NOT NULL,
  challenge_invoice TEXT NOT NULL,
  preimage_response BLOB,           -- NULL avant réponse
  state TEXT NOT NULL,             -- 'open' | 'verified' | 'expired' | 'failed'
  deadline_unix INTEGER NOT NULL,
  preimage_checker BLOB,           -- 50 sats payés par checker
  anchor_id INTEGER REFERENCES anchors(id),
  merkle_path BLOB,
  created_at INTEGER NOT NULL,
  verified_at INTEGER
);
CREATE INDEX ix_check_target ON liveness_checks(target_pk, created_at);

CREATE TABLE anchors (
  id INTEGER PRIMARY KEY,
  merkle_root BLOB NOT NULL,
  btc_txid BLOB,
  btc_block INTEGER,
  count INTEGER NOT NULL,
  anchored_at INTEGER NOT NULL,
  fee_sat_vb INTEGER NOT NULL,
  rbf_attempts INTEGER NOT NULL DEFAULT 0
);
```

## SDK npm + Python

```typescript
import { SatRankLiveness } from '@satrank/liveness';

post_bond(agent_pk, amount_sats, duration_blocks, signer) -> BondReceipt
check_liveness(target_pk, opts={ window_seconds: 60 }) -> CheckResult
respond_to_check(check_id, target_signer) -> void  // côté target
submit_slashing(proof, submitter_signer) -> SlashingReceipt
get_liveness_state(pubkey) -> LivenessState
verify_slashing_offline(slashing_proof, bitcoin_node_url) -> bool
```

## Économie

- **Bond minimum 100k sats** (~$60 à $60k/BTC) — barrière économique réelle anti-sybil
- **50 sats / liveness check** = ~$0.03 ; un escrow >10k sats absorbe trivialement 0.5% pour cette assurance
- **0.3% annualisé bond fee** = ~300 sats/jour sur 100k bond
- Volume estimé 2030 (architecte agent IDEA_1 estimate) : 2-5M checks/jour à 50 sats = 100-250M sats/jour ≈ $60k-$150k/jour
- 50k nouvelles ouvertures bond/jour × bond fee = 5M sats/jour
- Marge SatRank : ~95%

## Privacy

- Le challenge_nonce randomise chaque check → pas de corrélation triviale
- Le checker peut utiliser une stealth pubkey BIP-352 → SatRank ne corrèle pas l'identité long-terme du checker
- Le bond on-chain leak l'agent_pubkey → solution V1.1 : bonds en MuSig2 plus tard

## Anti-fraud

- Slashing par n'importe qui (50% reward au submitter) → incitation économique massive à dénoncer la fraude
- Double-sig détection cryptographique = mécanique, pas humaine
- Réseau de challengers distribués → pas de single point of censorship pour les checks

## Métriques de "fini"

1. ✅ 7/7 audit consensus sur SPEC_VALIDE + INDISPENSABLE
2. Code MIT/0BSD publié AVANT 1er ancrage public
3. POST /bond/post + check + respond + slashing fonctionnels
4. Cron OP_RETURN ≥ 7 ancrages consécutifs
5. Test E2E : 1 bond + 1 check OK + 1 slashing simulé contre une pubkey hostile
6. SDK npm + Python publiés
7. ≥ 1 bond posté par 1 pubkey externe non-Romain
8. ≥ 1 fork tiers en prod ou reproduction du verifier dans 3ème langue

## Kill switch empirique

Pendant 30 premiers jours : si < 10 bonds postés, < 100 checks/jour, 0 slashing, ou aucun pubkey externe → admettre que le marché ne valide pas la primitive → arrêter.

## Doctrine du test d'acceptance

> *Un fork qui démarre demain peut-il honorer les bonds SatRank d'avril 2026 ?* Non — il n'a pas (a) le pool économique agrégé, (b) les TX de slashing pré-signées par adaptor sig, (c) l'historique des checks ancré L1.
> *La liveness présente cryptographiquement vérifiée + skin-in-the-game slashable = la primitive manquante des escrows agent-agent 2030.*

## Question round suivant

Cette spec **SatRank Liveness V1.0**, issue du brainstorm collectif (TOP_1 de 4 agents + CONSENSUS de 3 agents au round 1 brainstorm), rend-elle SatRank techniquement saine (SPEC_VALIDE) **ET** indispensable pour un agent IA Bitcoin-souverain 2030 qui veut transactor avec un inconnu sans tribunal (INDISPENSABLE) ?
