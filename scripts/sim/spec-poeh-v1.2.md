# SatRank PoEH — spec V1.2 (non-trivial vs OTS+DIY)

**Round 4 a convergé sur** : "OpenTimestamps + Schnorr cosig DIY = équivalent commodifié, recomposable en quelques jours". V1.2 répond avec deux primitives cryptographiques non-triviales que OTS+DIY ne reproduit pas :

1. **Bearer aggregation O(log N)** via Merkle accumulator agent + ancrage récursif PoEH
2. **Mesh inter-opérateurs cross-attesting** via Nostr kind 31403 + inclusion mutuelle des roots

Plus une **section comparative explicite** : tableau "PoEH vs OTS+DIY" qui force l'évaluation honnête de la non-équivalence.

## Mission inchangée

Fournir une primitive cryptographique permettant à un agent Bitcoin souverain de prouver son passé économique à un inconnu, sans permission, sans intermédiaire de confiance unique, vérifiable offline contre Bitcoin L1, **avec preuve compacte O(log N) et défense par effet de réseau d'observateurs**.

## Pourquoi PoEH n'est pas OTS+DIY

| Capacité | OTS + Schnorr DIY | PoEH V1.2 |
|---|---|---|
| Timestamp un hash sur L1 | ✓ gratuit, batché | ✓ 10 sats |
| Cosignature mutuelle 2-of-2 | ✓ BIP-340 standard | ✓ |
| Commitments privacy SHA256 | ✓ trivial | ✓ |
| Vérifiable offline | ✓ | ✓ |
| **Bearer aggregation O(log N)** prouvant "j'ai N attestations" en 1 root + log(N) hashes | **✗** OTS ancre des hashes individuels, pas de structure d'agrégation | **✓** Merkle accumulator agent + ancrage récursif |
| **Mesh d'observateurs cross-attesting** où une attestation est valide contre n'importe quel observateur du réseau | **✗** OTS calendars sont indépendants, pas d'inclusion mutuelle | **✓** Nostr kind 31403 inter-anchor |
| **Format canonique pour cosignature payee mandatoire** que les SDK tiers respectent | **✗** chaque agent invente son format → fragmentation | **✓** spec ouverte fixe |
| **Bearer assets transférables P2P** (Phase B Cashu tokens) | **✗** un timestamp OTS n'est pas un bearer | **✓** Phase B activable |

L'effort de reproduire (1) + (2) en DIY = **non-trivial**. Le coût n'est pas dans la cryptographie de base (Schnorr + SHA256 + Merkle sont publics) — il est dans la **convergence sur UN format + UN effet de réseau d'observateurs**. Solo dev qui DIY recommence à zéro chaque agent ; PoEH est fait une fois, partagé par tous.

## Doctrine immuable

✗ x402 / USDC / EVM / stablecoin non-Bitcoin
✗ BIP submission / standardisation cross-écosystème
✗ Compliance, KYC, AML
✗ Partenariats Lightning Labs / Anthropic / Coinbase
✗ Tribunal humain ou comité d'oracle
✗ Cohabitation V1/V2
✓ Solo dev + Bitcoin-pur strict + open-source MIT/0BSD obligatoire dès J1
✓ Privacy-by-default (Hughes' selective revelation)

## Architecture forkable multi-opérateur (V1.0+)

Code MIT/0BSD publié AVANT premier ancrage public. N'importe qui fait tourner son propre opérateur. SatRank.dev = un parmi N. `observer_pubkey` libre.

**NOUVEAU V1.2** : les opérateurs forment un **mesh** via Nostr — chacun publie sa root quotidienne en Nostr kind 31403, et inclut dans son own root du jour suivant les roots des autres opérateurs qu'il choisit de reconnaître. Le graphe d'opérateurs est emergent et public, pas centralisé.

## Spec produit — privacy-preserving + aggregation

### POST /attest — 10 sats Lightning (inchangé V1.1)

Input avec commitments SHA256, cosig payer + payee obligatoires.

### POST /aggregate — gratuit (NOUVEAU V1.2)

L'agent maintient localement son propre Merkle tree de ses observation_ids (peut être stocké dans son wallet). Il ancre la racine de ce Merkle local via une attestation PoEH normale avec `service_tag = "poeh:aggregate"`. La preuve d'inclusion d'une observation dans ce root local prouve par transitivité son inclusion dans Bitcoin L1.

```json
// Input
{
  "agent_pubkey": "<32B hex>",
  "agent_nonce": "<32B hex>",
  "local_merkle_root": "<32B hex>",
  "ts_unix": <i64>,
  "agent_sig": "<64B Schnorr sur canonical>"
}

// Output
{
  "aggregate_observation_id": "<32B>",
  "invoice": "<BOLT11 10 sats>",
  "next_anchor_at": <unix>
}
```

**Preuve d'historique compacte** : pour prouver "j'ai N attestations", l'agent fournit :
- 1 aggregate_observation ancré
- N proofs Merkle locales (log(N) hashes chacune)
- Preuves PoEH des observations individuelles révélées (subset)

**Vérification O(1) côté tiers** :
1. Vérifier l'aggregate observation est ancré L1 (1 Bitcoin header check)
2. Vérifier chaque preuve révélée appartient au local Merkle (log(N) hashes)
3. Optionnel : vérifier chaque observation individuelle est ancrée L1 (échantillonnage)

C'est ce que OTS ne fait PAS. OTS prouve `existed_at(hash)`. PoEH prouve `existed_at(root_of_my_aggregator)` ET `inclusion_in_my_aggregator(individual_attestation)`. Composition = preuve compacte d'un historique.

### POST /reveal_history (V1.1) — révélation sélective

Inchangé. L'agent révèle qui il veut, quand il veut.

### GET /proof/:observation_id — gratuit

Retourne Merkle path L1 + cross-anchor refs (V1.2 nouveau).

### GET /mesh — gratuit (NOUVEAU V1.2)

Retourne la liste des opérateurs PoEH qui co-ancrent — `[{operator_pubkey, last_anchor_block, last_seen_in_kind_31403}]`. Permet à un agent de découvrir le réseau d'observateurs sans intermédiaire central.

### Cron quotidien — extended V1.2

1. SELECT observations payées non-ancrées
2. SHA256d Merkle tree RFC 6962
3. **Inclure dans le root la liste des `last_observed_roots` des autres opérateurs PoEH du jour précédent** (lus depuis Nostr kind 31403)
4. PSBT avec strict 1 OP_RETURN ≤ 80B = `<MAGIC 0x53524b32> <merkle_root 32B>`
5. Fee strategy P75 + RBF + fallback (V1.0)
6. Broadcast Bitcoin L1
7. **Publier sur Nostr kind 31403** (NOUVEAU) : `{operator_pubkey, root, btc_txid, block_height, included_peer_roots: [...]}` signé Schnorr
8. Persist + update merkle_path par observation

L'inclusion mutuelle des roots crée un graphe : si l'agent A a ancré chez opérateur X qui a inclus la root de Y, alors l'attestation de A est cryptographiquement liée à la root de Y. Un consommateur qui fait confiance à Y peut vérifier A même sans interroger X — il vérifie la chaîne d'inclusions Nostr.

## Tables DB (3 maintenant — observations + anchors + peer_anchors)

```sql
CREATE TABLE observations (...) -- inchangé V1.1
CREATE TABLE anchors (...) -- inchangé V1.0

-- NOUVEAU V1.2
CREATE TABLE peer_anchors (
  id INTEGER PRIMARY KEY,
  peer_operator_pk BLOB NOT NULL,
  peer_root BLOB NOT NULL,
  peer_btc_txid BLOB,
  peer_btc_block INTEGER,
  observed_at INTEGER NOT NULL,
  included_in_anchor_id INTEGER REFERENCES anchors(id)
);
CREATE INDEX ix_peer_op ON peer_anchors(peer_operator_pk, observed_at);
```

## SDK npm + Python — privacy + aggregation + mesh

```typescript
attest(...)           // V1.1, sub-ms cosig
aggregate(observation_ids, agent_pubkey, agent_nonce)
                      // NOUVEAU : ancre la racine du Merkle local de l'agent
reveal_history_to(...) // V1.1, révélation sélective
verify_history(...)    // V1.1, offline
verify_aggregate(BearerAttestation, partial_proofs, bitcoin_node)
                      // NOUVEAU : vérifie une preuve compacte O(log N)
fetch_mesh()          // NOUVEAU : découvre les autres opérateurs PoEH via Nostr
```

## Anti-sybil heuristiques (V1.0+)

Inchangé. PoEH fournit la matière première du graphe ; les consommateurs appliquent leurs heuristiques.

**NOUVEAU V1.2** : *cross-operator counterparty diversity* — un agent dont les contre-parties sont ancrées chez **plusieurs opérateurs PoEH** (mesure du graphe Nostr 31403) est plus crédible qu'un agent dont 100% des contre-parties ancrent chez le même opérateur (potentielle collusion).

## Phase B (déclenchée par métriques) — Cashu bearer

Wrap aggregate observations en bearer Cashu tokens (NUT-00/01/02).

## Métriques de "fini"

1. ✅ 7/7 audit consensus sur SPEC_VALIDE + INDISPENSABLE
2. Code MIT/0BSD publié AVANT 1er ancrage public
3. POST /attest, /aggregate, /reveal_history fonctionnels en prod
4. Cron OP_RETURN ≥ 7 ancrages consécutifs mainnet, avec inclusion mutuelle Nostr kind 31403
5. Test E2E : 1 paiement LN + 1 receipt cosigné + 1 aggregate + 1 vérification offline avec preuve O(log N)
6. SDK npm + Python publiés exposant les 5 fonctions sans dépendance satrank.dev
7. ≥ 1 attestation cosignée par 1 pubkey externe non-Romain
8. ≥ 1 fork tiers en prod (et au moins 2 opérateurs co-ancrant via Nostr 31403)

## Kill switch empirique

Pendant 30 premières attestations / 1er mois prod : si > 50 % mono-signées, 0 pubkey non-Romain, ou 0 fork tiers → admettre échec.

## Doctrine du test d'acceptance

> *Un fork qui démarre demain peut-il honorer ce que SatRank émet aujourd'hui ?* Non — il n'a pas le mesh d'observateurs cross-attesting de PoEH.
> *What cannot be forked is time. Time is the product.*
> *Privacy is the power to selectively reveal oneself to the world.* (Eric Hughes, 1993)
> **PoEH ≠ OTS + DIY** parce que : (a) preuve compacte O(log N) via aggregation récursive, (b) mesh d'observateurs cross-attesting, (c) format canonique partagé qui survit à la fragmentation.

## Question à valider — round 5

Cette spec V1.2 répond-elle au blocker convergent du round 4 ("OTS + Schnorr DIY recompose la même chose") en ajoutant deux primitives cryptographiques non-triviales (aggregation O(log N) + mesh cross-attesting) sans devenir une usine à gaz ?
