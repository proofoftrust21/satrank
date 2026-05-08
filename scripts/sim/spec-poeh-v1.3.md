# SatRank PoEH — spec V1.3 (network-by-protocol)

**Round 5 a convergé sur** : "le mesh est postulé, pas réel, donc N=1 → OTS+DIY suffit". V1.3 répond avec un **changement structurel** : le réseau d'observateurs n'est PAS une feature optionnelle, c'est **un invariant du protocole**.

**Trois changements vs V1.2** :

1. **Threshold 3-of-N observateurs OBLIGATOIRE** — une attestation sans 3 cosignatures distinctes d'observateurs **burned** est rejetée par le verifier offline lui-même, indépendamment de l'opérateur. Pas une politique, une règle de validation cryptographique.
2. **Burn cost observer ≥ 100 000 sats** ancré L1 — pour qu'une pubkey serve d'observer, elle doit avoir burned ≥100k sats vers OP_RETURN avec format `<MAGIC 0x53524f33> <observer_pubkey 32B>`. Vérifiable offline.
3. **Le receipt EST un Nostr event kind 31402** — standard ouvert, pas un format SatRank propriétaire. N'importe quel relais Nostr le porte. Pas de SatRank.dev requis pour la diffusion.

## Mission

Fournir une primitive cryptographique permettant à un agent Bitcoin souverain de prouver son passé économique à un inconnu, **avec validation cryptographique multi-observateur burned, sans permission, vérifiable offline contre Bitcoin L1**.

## Pourquoi V1.3 n'est pas reproductible par OTS+DIY

OTS + Schnorr DIY peut faire :
- Timestamp + cosignature payer/payee : trivial

OTS + Schnorr DIY ne peut PAS faire (sans recoder PoEH lui-même) :
- **Validation 3-of-N observers burned** = la règle de vérification offline rejette toute attestation qui n'a pas 3 cosigs d'observers ayant burned ≥100k sats
- **Format Nostr kind 31402 partagé** = effet de réseau de relais Nostr porteurs
- Observer registry avec burn cost = barrière économique réelle (un fork doit attirer 3+ pubkeys burned, ou faire 3 burns lui-même = 300k sats minimum côté agent reproduit)

Le threshold est une règle **cryptographique** au niveau du verifier, pas une politique opérationnelle. Un fork qui produit des attestations 1-of-1 produit des objets **non-conformes au protocole PoEH**. Un consommateur qui suit le protocole les rejette.

## Doctrine immuable (inchangée)

✗ x402 / USDC / EVM / stablecoin non-Bitcoin
✗ BIP submission externe
✗ Compliance, KYC, AML
✗ Partenariats Lightning Labs / Anthropic / Coinbase
✗ Tribunal humain ou comité d'oracle
✗ Cohabitation V1/V2
✓ Solo dev + Bitcoin-pur + open-source MIT/0BSD dès J1
✓ Privacy-by-default (Hughes' selective revelation)

## Architecture protocol-level

### Le réseau d'observateurs est dans le protocole

**Invariant** : pour qu'une attestation PoEH soit valide cryptographiquement, elle doit contenir 3 cosignatures Schnorr **d'observateurs burnés distincts**. C'est le verifier offline qui le vérifie, pas un serveur central.

```
ValidationRule (vérifiable offline) :
  - cosig_payer valide BIP-340
  - cosig_payee valide BIP-340 (REQUIRED, pas de downgrade)
  - 3 cosigs observateurs distincts (observer_1, observer_2, observer_3)
  - chaque observer_i a un burn record ancré L1 ≥ 100 000 sats avec
    OP_RETURN format `<MAGIC 0x53524f33> <observer_pubkey 32B>`
  - le burn record doit être ancré dans un block antérieur à ts_unix
  - les 3 observateurs sont distincts (pubkeys différentes)
  - aggregate signature : MuSig2 des 3 cosigs sur sha256(canonical)
```

### Bootstrap honnête

Pour démarrer, **3 pubkeys d'observateurs burned doivent exister** sur Bitcoin L1 avant la première attestation. Romain peut auto-bootstrapper : 3 wallets distincts, chacun burn 100k sats. Coût de bootstrap = 300k sats one-time (~$180 à $60k/BTC). C'est honnête et public ; Romain dispose des sats.

Le bootstrap auto-référencé est :
- **Documenté publiquement** sur le repo open-source
- **Anti-shitcoin** : pas de pre-mine, pas de tokens non-Bitcoin, juste un coût économique réel et visible
- **Symbolique** : Romain s'engage 300k sats que d'autres observateurs viennent

Au fil du temps, des tiers peuvent burn pour devenir observateurs payés (chaque attestation distribue 3 sats sur les 10, 1 sat par observer-cosig — voir économie ci-dessous).

### Multi-opérateur libre (V1.0+)

Code MIT/0BSD avant 1er ancrage. N'importe qui peut faire tourner son propre opérateur PoEH. SatRank.dev = un parmi N. Le protocole n'a pas d'autorité.

## Spec produit

### Receipt = Nostr event kind 31402 (NOUVEAU V1.3)

```
{
  "kind": 31402,
  "created_at": <ts_unix>,
  "pubkey": "<observer_1_pubkey>",
  "tags": [
    ["v", "1"],
    ["payer_commit", "<32B SHA256>"],
    ["payee_commit", "<32B SHA256>"],
    ["amount_commit", "<32B SHA256>"],
    ["service_commit", "<32B SHA256>"],
    ["payment_hash", "<32B Lightning HTLC hash>"],
    ["cosig_payer", "<64B Schnorr>"],
    ["cosig_payee", "<64B Schnorr — REQUIRED>"],
    ["observer", "<observer_1_pubkey>", "<sig>"],
    ["observer", "<observer_2_pubkey>", "<sig>"],
    ["observer", "<observer_3_pubkey>", "<sig>"],
    ["burn", "<observer_1_pubkey>", "<txid_burn_op_return>"],
    ["burn", "<observer_2_pubkey>", "<txid_burn_op_return>"],
    ["burn", "<observer_3_pubkey>", "<txid_burn_op_return>"]
  ],
  "content": "",
  "id": "<sha256>",
  "sig": "<MuSig2 aggregate des 3 observer sigs>"
}
```

Diffusable sur n'importe quel relais Nostr. Pas de format propriétaire. Pas de dépendance SatRank.dev.

### Économie de la fee 10 sats (NOUVEAU V1.3)

L'agent paie 10 sats Lightning à l'opérateur PoEH (qui gère l'ancrage cron) :
- **3 sats redistribués** aux 3 observateurs cosignataires (1 sat chacun) via Lightning split-payment
- **5 sats** restent à l'opérateur PoEH (anchor cost amorti + infrastructure)
- **2 sats** brûlés (OP_RETURN des cosigs ou burn directe)

L'incitation économique des observateurs : burn 100k sats one-time pour ensuite gagner 1 sat par attestation cosignée. Break-even à 100 000 attestations cosignées par observer. À volume mature, c'est rentable.

### POST /attest — 10 sats

L'opérateur public PoEH coordonne la collecte des 3 cosignatures observers. Le SDK agent peut soit :
- Choisir 3 observers spécifiques (préférence locale)
- Laisser l'opérateur choisir aléatoirement parmi le registre des observateurs burned

Le receipt résultant est diffusé sur Nostr kind 31402 ET ancré dans le Merkle quotidien de l'opérateur.

### POST /aggregate — gratuit (V1.2)

Aggregation O(log N) inchangé.

### POST /reveal_history — gratuit (V1.1)

Révélation sélective inchangé.

### GET /observers — gratuit (NOUVEAU V1.3)

Retourne la liste des pubkeys d'observateurs burned actifs : `[{observer_pubkey, burn_txid, burn_block, attestations_signed_count, last_active}]`. Lecture du registre, pas de mutation.

### GET /proof/:observation_id — gratuit (V1.0)

Merkle path L1 + Nostr event id + 3 burn txids des observers.

### Cron quotidien (V1.0+)

Inchangé. Inclut désormais aussi les Nostr kind 31402 events publiés par les observateurs comme inputs auxiliaires.

## Tables DB (3)

```sql
CREATE TABLE observations (...) -- V1.1, ajout :
  observer_1_pk BLOB NOT NULL,
  observer_2_pk BLOB NOT NULL,
  observer_3_pk BLOB NOT NULL,
  observer_aggregate_sig BLOB NOT NULL,  -- MuSig2

CREATE TABLE anchors (...) -- V1.0 inchangé

CREATE TABLE observer_burns (
  id INTEGER PRIMARY KEY,
  observer_pk BLOB UNIQUE NOT NULL,
  burn_txid BLOB NOT NULL,
  burn_amount_sats INTEGER NOT NULL,
  burn_block_height INTEGER NOT NULL,
  burn_block_hash BLOB NOT NULL,
  registered_at INTEGER NOT NULL
);
CREATE INDEX ix_obs_burn_pk ON observer_burns(observer_pk);
```

3 tables — toujours sous la doctrine.

## SDK npm + Python

```typescript
attest({
  payer_pk, payer_nonce, payee_pk, payee_nonce,
  amount_sats, amount_nonce, payment_hash,
  service_tag, service_nonce, ts_unix
}, signer, observer_choice = "auto" | observer_pubkeys[])
  // → calcule canonical avec commitments
  // → demande cosig payee
  // → coordonne avec 3 observers (auto via opérateur ou choisis)
  // → publie Nostr kind 31402
  // → retourne observation_id
verify_history(...) // V1.1, étendu pour vérifier 3-of-N observers burned
register_observer(observer_pk, burn_txid)
  // NOUVEAU : déclare une pubkey comme observer après burn 100k sats L1
```

## Anti-sybil — multi-couche

V1.0+ heuristiques (counterparty diversity, burn-rooted distance, time-anchored age) **PLUS** :
- **Observer rotation** : les 3 observers d'une attestation doivent être distincts ET avoir leur burn ancré ≥ 100 blocs avant l'attestation
- **Observer monoculture detection** : si un agent n'a que 3 observateurs récurrents (toujours les mêmes), score sybil augmente
- **Observer burn dilution** : un observer qui a co-signé pour 1M attestations a son `effective_burn` = `100k / 1M` sats par attestation = trop dilué pour être probant

## Phase B (déclenchée) — Cashu bearer (V1.0+)

Inchangé.

## Métriques de "fini"

1. ✅ 7/7 audit consensus sur SPEC_VALIDE + INDISPENSABLE
2. Code MIT/0BSD publié AVANT 1er ancrage
3. **3 observateurs burned distincts ancrés L1** avant 1ère attestation (bootstrap honnête)
4. POST /attest, /aggregate, /reveal_history, /observers fonctionnels
5. Cron OP_RETURN ≥ 7 ancrages consécutifs avec inclusion mutuelle Nostr 31403
6. Test E2E : 1 paiement LN + 1 receipt 3-of-N + 1 ancrage + 1 vérification offline avec validation 3-of-N burned
7. SDK npm + Python publiés
8. ≥ 1 attestation cosignée par 1 pubkey externe non-Romain (payer ou payee)
9. ≥ 1 fork tiers en prod ET ≥ 2 opérateurs co-ancrant via Nostr 31403

## Kill switch

Si dans 30 premières attestations / 1er mois prod : > 50 % rejetées car non 3-of-N burned, 0 observer externe non-Romain, 0 fork tiers → admettre échec.

## Doctrine du test d'acceptance

> *Un fork qui démarre demain peut-il honorer ce que SatRank émet aujourd'hui ?* Non — il n'a pas (a) le mesh d'observateurs cross-attesting, (b) les 3-of-N observer burns historiques, (c) le format Nostr 31402 standardisé.
> *What cannot be forked is time + economic burn.*
> *Privacy is the power to selectively reveal.* (Hughes)
> **PoEH ≠ OTS + DIY** parce que la règle de validation cryptographique exige 3-of-N observers burned — un solo dev qui DIY produit des objets non-conformes au protocole, donc rejetés.

## Question round 6

Cette spec V1.3 répond-elle au blocker convergent de R5 ("OTS+DIY recompose tout") en intégrant **par règle cryptographique du verifier** un threshold 3-of-N observers burned, sans devenir une usine à gaz ?
