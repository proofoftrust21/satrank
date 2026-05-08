# SatRank Equivocation Bond — spec V1.6 (privacy + atténuation MEV)

**R17 = 7/7 SPEC_VALIDE / 2/7 INDISP** — premier consensus technique complet. Reste 5 blockers indispensabilité :

1. **A2 cypherpunk** : leak `R_bond` + `domain_tag` publics → privacy violée
2. **A5 Bitcoin max** : MEV miner détruit incitation bounty hunter
3. **A1, A6, A7** : DLC adaptor sigs ad-hoc + HTLC suffisent pour les cas adjacents

V1.6 fixe les 3 thèmes :

## Fix #1 — Privacy : commits Cashu blinded (réponse A2)

### Le problème V1.5

Le bond expose publiquement on-chain : `agent_pubkey`, `domain_tag`, `R_bond`. Hughes 1993 : *"Privacy is the power to selectively reveal oneself to the world"*. Tout broadcast public d'engagement viole.

### Fix V1.6 — bond commitment hashé + révélation sélective

Au moment du dépôt, l'agent commit à `bond_commit = SHA256(agent_pubkey || R_bond || domain_tag || nonce_local)` au lieu de publier les valeurs en clair. Le `nonce_local` est conservé secrètement par l'agent.

L'OP_RETURN ancré quotidiennement contient seulement le **Merkle root** des `bond_commit` du jour. Personne ne peut décoder qui a bondé sur quoi sans connaître les pré-images.

**Révélation sélective** : quand l'agent veut prouver à un partenaire B qu'il a un bond actif sur `domain_tag X`, il révèle à B (et seulement à B) les pré-images : `(agent_pubkey, R_bond, domain_tag, nonce_local) + Merkle path → bond_commit ∈ root_L1`. B vérifie offline contre Bitcoin headers.

L'équivocation publique reste détectable : **dès que l'agent signe deux fois avec le même `R_bond` sous le même `domain_tag`**, les deux signatures sont publiques (par définition, c'est ce que l'agent signe pour son business). N'importe qui qui voit les deux signatures peut révéler le bond_commit correspondant.

**Zero-knowledge enhancement** (V2 future) : utiliser MuSig2 ring signatures pour l'agent_pubkey lui-même → l'identité reste privée jusqu'à révélation sélective.

V1.6 minimum viable = bond_commit hashé. Ça respecte Hughes en V1.

## Fix #2 — Atténuation MEV : Lightning-paid commit-reveal slashing (réponse A5)

### Le problème V1.5

Le revealer broadcast une TX qui contient `x` dans le witness → miner peut frontrun en substituant sa propre TX. Bounty hunters perdent prime → pas de scanning → primitive cassée.

### Fix V1.6 — reveal-commitment via Lightning (sealed-broadcast)

Workflow :
1. Le revealer détecte les deux signatures contradictoires
2. Le revealer signe LOCALEMENT la TX de slashing avec `x` (vers son wallet)
3. Le revealer **paye 1000 sats Lightning à un mempool relay-as-a-service** (open-source, n'importe qui peut faire tourner) qui s'engage **par réputation économique** à inclure cette TX en priorité dans le prochain block
4. Le relay broadcast au moment optimal (juste avant qu'un block trouve une template), minimisant la fenêtre miner-frontrun
5. Le relay fait du MEV-protection au niveau mempool (private mempool / Stratum V2 / direct-to-pool)

C'est **trust-based mais distribué** — n'importe qui peut faire tourner un mempool relay (open-source MIT). Si un relay rug-pull (révèle x avant inclusion), il perd sa réputation et personne n'utilise.

C'est **identique au Flashbots ecosystem Ethereum** transposé Bitcoin-pure. Production-grade depuis 2021.

### Alternative — via Stratum V2 directement

Avec Stratum V2 (déployé Bitcoin Core 28+, mainnet 2025+), n'importe qui peut soumettre des templates directement aux mining pools. Le revealer paie un fee inclus dans la TX → priorité automatique. Pas besoin de relay tiers.

V1.6 supporte les deux : SDK propose `broadcast_via_relay()` ou `broadcast_via_stratum_v2()`.

## Fix #3 — Distinction DLC ad-hoc + élargir cible (réponse A1, A6, A7)

A1, A6, A7 disent : "DLC adaptor sigs ad-hoc + HTLC couvrent les cas voisins".

**Distinction maintenue V1.6** :

- **DLC ad-hoc** : N parties × N contrats = N bonds DLC. O(N²) friction.
- **Equivocation Bond V1.6** : 1 bond par agent par `domain_tag` (catégorie). O(N) friction.

Pour un agent qui veut être pris au sérieux dans **100 contrats DLC** sur "BTC price oracle attestation" (catégorie domain_tag), Equivocation Bond = 1 bond ; DLC ad-hoc = 100 bonds. **Économie d'échelle 100×**.

**Cible élargie V1.6** : pas juste "engagements non-atomiques" mais **TOUTE primitive de réputation économique cumulative cross-counterparty** :

- DLC oracle binding (price feeds, événements)
- Sealed-bid auctions M2M
- Compliance attestations engageantes
- DAO binding votes
- **Licences agents** (un agent commit à respecter une politique sur un domain_tag, perd le bond s'il viole — license économique)
- **Commitments publics longs-terme** (l'agent s'engage à publier des données sur un domain_tag jusqu'à T+N, équivocation = changement non-annoncé)
- **Service-level guarantees** (un opérateur Lightning bonde sur "uptime 99% sur ce node", équivocation = downtime non-annoncé)

C'est une **primitive de réputation cumulative scalable**. C'est ce que les DLC ad-hoc ne fournissent **PAS** — ils sont per-contract.

## Doctrine immuable (inchangée)

✗ x402 / USDC / EVM / stablecoin non-Bitcoin
✗ BIP submission externe
✗ Compliance, KYC, AML
✗ Partenariats Lightning Labs / Anthropic / Coinbase
✗ Tribunal humain ou comité d'oracle
✗ Cohabitation V1/V2
✓ Solo dev + Bitcoin-pur strict + open-source MIT/0BSD dès J1
✓ Privacy-by-default (V1.6 fix : commits hashés)

## Spec produit (3 endpoints, 2 tables, 1 cron)

### POST /bond/post

```json
// Input
{
  "bond_commit":      "<32B SHA256(agent_pk || R_bond || domain_tag || nonce_local)>",
  "bond_amount_sats": <u64 ≥ 100_000>,
  "duration_blocks":  <i64 ≥ 144>,
  "deposit_psbt":     "<PSBT signée par l'agent — UTXO Taproot key-path = agent_pubkey>",
  "agent_sig":        "<64B Schnorr proof of knowledge of preimage, sans révéler preimage>"
}
```

L'agent prouve qu'il connaît la préimage via une **commit-and-prove ZK** (simplifiée : Schnorr proof-of-knowledge sur le commit + signature séparée).

```json
// Output
{
  "bond_id":              "<32B>",
  "deposit_txid":         "<32B>",
  "deposit_block_height": <i64>,
  "anchor_eta_block":     <i64>
}
```

### POST /reveal — gratuit (révélation sélective)

L'agent envoie à un partenaire spécifique B :
```json
{
  "bond_id":     "<32B>",
  "agent_pk":    "<32B>",
  "R_bond":      "<33B>",
  "domain_tag":  "<UTF-8>",
  "nonce_local": "<32B>",
  "merkle_path": "<bytes>"
}
```

B recompute SHA256, vérifie le path contre le root L1 du jour. Aucune information à SatRank.

### POST /slashing/submit — gratuit

Le submitter présente les deux signatures contradictoires + la révélation des préimages (qu'il aurait extraites via observation publique des signatures + brute-force ou révélation antérieure par l'agent à un partenaire). SatRank vérifie cryptographiquement, calcule x, publie la preuve via Nostr **après que le slashing soit confirmé** (via vérification mempool/block).

### POST /broadcast/sealed — 1000 sats Lightning (NOUVEAU V1.6)

Le revealer paye 1000 sats à un mempool relay (SatRank.dev en exploite un par défaut, mais open-source). Le relay s'engage à broadcaster la TX de slashing en priorité minimisant la fenêtre miner-frontrun.

```json
// Input
{
  "tx_hex":  "<TX de slashing signée avec x>",
  "fee_min_sat_vb": <u32>,
  "deadline_block": <i64>
}
```

### GET /pool_stats/:domain_tag — gratuit

Statistiques agrégées du domain_tag (compte de bonds actifs, total sats locked, slashings historiques) **sans révéler les bonds individuels**.

### POST /scan/:domain_tag — 1 sat Lightning

Bounty hunters paient 1 sat pour obtenir l'index pré-traité des signatures observées sur Nostr récemment, indexées par R_bond candidat.

### Cron quotidien

Inchangé — Merkle root des bond_commit + slashings dans OP_RETURN ≤ 80B.

## Tables DB (2)

```sql
CREATE TABLE bond_commits (
  id BLOB PRIMARY KEY,
  bond_commit BLOB NOT NULL,        -- 32B SHA256(...)
  bond_amount_sats BIGINT NOT NULL,
  duration_blocks INTEGER NOT NULL,
  deposit_txid BLOB NOT NULL,
  deposit_block_height INTEGER NOT NULL,
  expires_block INTEGER NOT NULL,
  state TEXT NOT NULL,
  slashed_txid BLOB,
  slashed_at_block INTEGER,
  slashed_by_pubkey BLOB,
  extracted_x BLOB,                 -- NULL avant slashing
  revealed_agent_pk BLOB,           -- NULL avant slashing/révélation
  revealed_R_bond BLOB,
  revealed_domain_tag TEXT,
  anchor_id INTEGER REFERENCES anchors(id),
  merkle_path BLOB,
  posted_at INTEGER NOT NULL
);

CREATE TABLE anchors (...) -- inchangé V1.0
```

## SDK npm + Python (privacy + sealed-broadcast)

```typescript
post_bond(agent_pk, R_bond, domain_tag, amount_sats, duration_blocks, signer)
  -> { bond_id, bond_commit, nonce_local }
  // SDK calcule SHA256, garde nonce_local localement chiffré

reveal_to_partner(bond_id, partner_pubkey)
  -> { revelation_payload (encrypted to partner) }
  // Encryption Nostr NIP-04 ou similar — le partner décrypte et vérifie offline

submit_slashing_proof(bond_id_or_anchored_root, sig_1, msg_1, sig_2, msg_2, submitter_signer)
  -> { x_extracted, slashing_tx_unsigned }

broadcast_sealed(slashing_tx, fee_sat_vb, deadline_block, payer_signer)
  -> { bitcoin_txid }
  // 1000 sats Lightning à un mempool relay → MEV-protected broadcast

verify_bond_commit_offline(bond_commit, merkle_path, root_L1, bitcoin_node_url) -> bool

scan_for_equivocations(domain_tag, since_block, scanner_signer)
  -> { active_bonds, candidates_with_double_sig }
```

## Économie

- Bond min 100k sats × 100k bonds = 10G sats locked (~$6M TVL)
- Frais ouverture 0.3% annualisé = 300 sats/jour par 100k bond
- Frais sealed-broadcast 1000 sats × 50 slashings/jour = 50k sats/jour
- /scan : 1 sat × N hunters
- Volume estimé 2030 (cible élargie inclut licences + service-level guarantees + DAO votes) : 200-500k bonds actifs

## Privacy V1.6

✓ Bond commits hashés on-chain (pas de leak agent_pubkey ni domain_tag)
✓ Révélation sélective bilatérale via Nostr DM (NIP-04)
✓ Stats agrégées publiques sans détails individuels
⚠ Une fois équivoqué publiquement, l'identité fuit (mais c'est OK — l'agent fraudeur perd sa privacy par sa propre action)

## Anti-MEV V1.6

✓ Sealed-broadcast via mempool relay (1000 sats Lightning) — réduit fenêtre miner-frontrun
✓ Stratum V2 alternative quand mainnet
⚠ Trust dans le relay — mais open-source, plusieurs fournisseurs, marché concurrentiel

## Métriques de "fini"

1. ≥ 6/7 SPEC_VALIDE + ≥ 5/7 INDISPENSABLE (cible R18)
2. Code MIT/0BSD publié AVANT 1er ancrage
3. Endpoints fonctionnels
4. Cron OP_RETURN ≥ 7 ancrages consécutifs
5. Test E2E : bond commit posté + équivocation + révélation sélective vérifiée + slashing avec sealed-broadcast
6. SDK npm + Python publiés
7. ≥ 1 bond externe non-Romain
8. ≥ 1 slashing réussi via sealed-broadcast (preuve fonctionnelle MEV-protection)

## Doctrine du test d'acceptance

> *Privacy = bond_commit hashé + révélation sélective. Hughes verbatim respecté.*
> *MEV protection = mempool relay payé Lightning (production-grade Flashbots-style transposé Bitcoin).*
> *Cible élargie = primitive de réputation cumulative cross-counterparty O(N) vs DLC ad-hoc O(N²).*

## Question round 18

Cette spec **SatRank Equivocation Bond V1.6** :
- **Privacy fixée** (bond_commit hashé + révélation sélective)
- **MEV atténué** (sealed-broadcast via mempool relay)
- **Cible élargie** (réputation cumulative cross-counterparty, distinguée O(N) vs O(N²) DLC ad-hoc)

…rend-elle SatRank techniquement saine (SPEC_VALIDE = ≥6/7) **ET** indispensable pour les agents 2030 dans son slot ciblé élargi (INDISPENSABLE = ≥5/7) ?
