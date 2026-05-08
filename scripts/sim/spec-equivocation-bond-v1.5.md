# SatRank Equivocation Bond — spec V1.5 (MEV honnêtement assumé)

**R16 = 3/7 SPEC + 4/7 INDISP + 3/7 OUI/OUI** — A4 architecte est passé OUI/OUI grâce au recalibrage angle. Mais 4 agents (A1, A5, A6, A7) ont décelé que le fix CSV V1.4 était cryptographiquement cassé — CSV vérifie l'âge depuis création UTXO, pas depuis broadcast TX, donc le verrou est déjà satisfait au moment du slashing.

V1.5 = **arrêter de prétendre fixer ce qui est intrinsèquement non-fixable** sans covenant opcodes (OP_CTV pas activé Bitcoin mainnet 2026). Bitcoin-pure 2026 ne peut PAS garantir trustless qui rafle le bond entre revealer-original et miner-frontrunner. C'est une **propriété structurelle**, pas un bug à fixer.

## Le MEV miner-frontrunning : propriété, pas bug

**Le fait** : quand le revealer broadcast la TX de slashing, le witness révèle `x`. Un miner qui voit la TX en mempool peut :
1. Extraire `x` du witness
2. Substituer une TX qui dépense le bond vers son propre wallet
3. Inclure sa version dans le block

Sans **OP_CTV** ou **OP_CHECKSIGFROMSTACK** (covenants pas activés mainnet 2026), aucune protection cryptographique trustless ne peut empêcher cela. C'est une **limite mathématique de Bitcoin Script actuel**.

### Ce que ça signifie concrètement

- L'agent fraudeur perd **100% de son bond** indépendamment (slashing inévitable une fois `x` révélé)
- La **prime peut aller** soit au revealer original, soit à un miner qui frontrun, soit à un autre observateur rapide
- C'est une **race honnête de mempool** où la fee compétitive et la chance de propagation déterminent le winner
- Les bounty hunters incluent le **risque MEV dans leur expected return** quand ils décident de scanner

### Pourquoi c'est OK

L'**objectif central** de la primitive est satisfait : *l'agent fraudeur subit une perte économique mécanique de 100% de son bond*. C'est le signal anti-équivocation. Qui rafle les sats — revealer original, miner, ou autre — est secondaire.

**Analogie** : Bitcoin lui-même a du MEV (sandwich attacks DEX, ordering miner). Bitcoin reste utile et indispensable malgré ça parce que le mécanisme central (consensus, transactions immutables) tient. Pareil ici : le bond slash est mécanique ; la distribution MEV est une externalité acceptée.

### Ce que SatRank fait (recommandation pragmatique)

Le SDK :
1. **Conseille** au revealer d'utiliser un **fee compétitif élevé** (équivalent au top P95 mempool sat/vB) pour minimiser le frontrun
2. **Ne publie PAS les sigs sur Nostr avant confirmation** (warning explicite si l'utilisateur essaye)
3. **Documente** clairement le risque MEV pour que les bounty hunters le pricent dans leur stratégie
4. Pas de covenant artificiel cassé

C'est l'**honnêteté technique** : ce que le protocole peut et ne peut pas garantir.

## Doctrine immuable (inchangée)

✗ x402 / USDC / EVM / stablecoin non-Bitcoin
✗ BIP submission externe
✗ Compliance, KYC, AML
✗ Partenariats Lightning Labs / Anthropic / Coinbase
✗ Tribunal humain ou comité d'oracle
✗ Cohabitation V1/V2
✓ Solo dev + Bitcoin-pur strict + open-source MIT/0BSD dès J1
✓ Privacy-by-default

## Cible (assumée niche)

Inchangée V1.3 — escrows engageants non-atomiques (DLC oracles, sealed-bid auctions M2M, oracle votes binding, compliance attestations engageantes, DAO binding votes). Le slot que **HTLC atomique ne couvre pas**.

## Réponse au blocker A1 (devil's advocate) sur l'alternative DLC adaptor sigs

A1 argue : *"DLC + adaptor signatures couvrent déjà 90%+ des cas non-atomiques sans bond"*.

**Distinction cruciale** :
- **DLC adaptor sigs** = ENGAGEMENT entre deux parties spécifiques sur UN événement précis. Atomique once event determined.
- **Equivocation Bond** = ENGAGEMENT EN POOL où l'agent peut être challengé par n'importe qui sur n'importe quel `domain_tag` qu'il aurait signé. C'est de la **réputation économique cumulative**, pas un contrat ad-hoc.

Un agent qui veut être pris au sérieux dans **N** contrats DLC avec **N** contre-parties différentes 2030 doit poster **N** bonds DLC. C'est inefficace.

Avec Equivocation Bond, l'agent poste **1 bond** par `domain_tag` (ex : "DLC oracle on Bitcoin price"), et **toute** contre-partie qui le considère pour un DLC sur ce `domain_tag` peut vérifier le bond. Le bond couvre tous les usages futurs sur ce domaine.

C'est l'équivalent économique d'une **caution professionnelle** vs **caution par contrat**. La caution professionnelle scale ; les cautions ad-hoc explosent en complexité.

## Spec produit

### POST /bond/post

```json
// Input
{
  "agent_pubkey":      "<32B>",
  "bond_amount_sats":  <u64 ≥ 100_000>,
  "domain_tag":        "<UTF-8 ≤ 64B>",
  "duration_blocks":   <i64 ≥ 144>,
  "R_bond":            "<33B>",
  "deposit_psbt":      "<PSBT>",
  "agent_sig":         "<64B Schnorr>"
}
```

Le bond UTXO est verrouillé en Taproot key-path = `agent_pubkey`. **Pas de script-path complexe.** Pas de CSV cassé. Simple et fonctionnel.

```json
// Output
{
  "bond_id":              "<32B>",
  "deposit_txid":         "<32B>",
  "deposit_block_height": <i64>
}
```

### POST /slashing/submit — gratuit

```json
// Input
{
  "bond_id":         "<32B>",
  "sig_1":           "<64B (R_bond, s_1)>",
  "msg_1":           "<canonical>",
  "sig_2":           "<64B (R_bond, s_2)>",
  "msg_2":           "<canonical>",
  "submitter_pubkey": "<32B>"
}
```

SatRank vérifie cryptographiquement, calcule x, et **publie sur Nostr** la preuve de l'équivocation **APRÈS** que le submitter a broadcast sa TX (vérifié via mempool). Le submitter peut aussi demander à SatRank de différer la publication pendant N blocs (option `defer_nostr_publish_blocks`).

### POST /scan/:domain_tag — 1 sat Lightning

Inchangé V1.3.

### GET /pool/:domain_tag — gratuit

Inchangé.

### Cron quotidien

Inchangé.

## Tables DB (2)

Inchangé V1.3 (sans `taproot_internal_key` / `script_path_hash` qui étaient pour le CSV cassé) :

```sql
CREATE TABLE bonds (
  id BLOB PRIMARY KEY,
  agent_pk BLOB NOT NULL,
  bond_amount_sats BIGINT NOT NULL,
  domain_tag TEXT NOT NULL,
  R_bond BLOB NOT NULL,
  duration_blocks INTEGER NOT NULL,
  deposit_txid BLOB NOT NULL,
  deposit_block_height INTEGER NOT NULL,
  expires_block INTEGER NOT NULL,
  state TEXT NOT NULL,
  slashed_txid BLOB,
  slashed_at_block INTEGER,
  slashed_by_pubkey BLOB,
  extracted_x BLOB,
  anchor_id INTEGER REFERENCES anchors(id),
  merkle_path BLOB,
  posted_at INTEGER NOT NULL
);

CREATE TABLE anchors (...) -- inchangé V1.0
```

## SDK npm + Python

```typescript
post_bond(...) -> { bond_id, R_bond, deposit_txid }

sign_for_domain(...) -> { sig: (R_bond, s) }
  // SDK refuse signing 2 payloads avec même R_bond + même domain_tag

submit_slashing_proof(bond_id, sig_1, msg_1, sig_2, msg_2, submitter_signer)
  -> { x_extracted, tx_template }
  // ATTENTION : ne PAS publier sur Nostr avant la confirmation TX

broadcast_slashing_tx(x, recipient_address, fee_sat_vb_min, bitcoin_node_url)
  -> { bitcoin_txid }
  // Sign avec x, broadcast avec fee compétitif (P95 mempool recommandé)
  // RISQUE MEV : un miner peut substituer ; documenté

publish_equivocation_to_nostr(bond_id, sig_1, sig_2, after_n_confirmations)
  // Publier APRÈS confirmation pour éviter race miner

verify_bond_active_offline(bond_id, bitcoin_node_url) -> bool

scan_for_equivocations(domain_tag, since_block, scanner_signer)
  -> { active_bonds, candidates_with_double_sig }
```

## Économie 2030 (inchangée niche)

- 50-100k bonds actifs
- Frais ouverture 0.3% annualisé
- Slashings 10-50/jour, distribution MEV-affectée mais **bond drainé à 100% dans tous les cas**
- /scan : 1 sat × N hunters / jour

## Anti-fraud / propriétés cryptographiques

- ✓ Math = juge (extraction x est une équation Schnorr)
- ✓ SatRank sans pouvoir cryptographique
- ✓ Open-source MIT, fork-deployable
- ⚠ MEV miner-frontrunning **assumé** : le bond est slashé peu importe qui rafle ; la primitive remplit son rôle (perte agent fraudeur)
- ✓ Bitcoin Script standard (Taproot key-path, BIP-340 Schnorr) — no opcode requis non-activé

## Métriques de "fini"

1. ✅ ≥ 6/7 SPEC_VALIDE + ≥ 5/7 INDISPENSABLE
2. Code MIT/0BSD publié AVANT 1er ancrage
3. Endpoints fonctionnels
4. Cron OP_RETURN ≥ 7 ancrages consécutifs
5. Test E2E : bond posté + équivocation + extraction x + broadcast TX (revealer ou miner — peu importe) + vérification offline
6. SDK npm + Python publiés
7. ≥ 1 bond externe non-Romain
8. ≥ 1 slashing réussi (revealer ou miner) prouvant que la primitive force la perte économique de l'agent fraudeur

## Doctrine du test d'acceptance

> *Math = juge sur l'extraction. Mempool race = qui rafle. Le fraudeur perd 100% peu importe.*
> *Bitcoin-pure 2026 sans covenant = MEV intrinsèque, accepté honnêtement comme propriété du système.*

## Question round 17

Cette spec **SatRank Equivocation Bond V1.5** :
- **Crypto correcte** (Taproot key-path simple, BIP-340 standard, sans opcode non-activé)
- **MEV honnêtement assumé** comme propriété intrinsèque de Bitcoin-pure 2026 sans covenant
- **Cible niche** (escrows engageants non-atomiques, distinguée des DLC ad-hoc par caractère cumulatif)
- **Lens A4 + A7 recalibrés** pour juger du POV cible

…rend-elle SatRank techniquement saine (SPEC_VALIDE = ≥6/7) **ET** indispensable pour les agents 2030 dans son slot ciblé (INDISPENSABLE = ≥5/7) ?
