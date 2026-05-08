# SatRank Auctions — spec V1.0 (candidat produit phare)

**Pivot R8 → R9** : abandon Cashu mint (trusted intermediary, fongibilité tokens). Test d'un produit où la valeur vient de **la temporalité Bitcoin** : sealed-bid commit-reveal pour ressources scarce M2M.

## Ce qu'est le produit

En 2030, des agents IA Bitcoin-souverains s'enchèrent sur des ressources scarce : slots GPU pour inférence, slots de routage Lightning haute priorité, créneaux block-space Bitcoin, attentes API premium, accès limité à des data feeds. Pour qu'une enchère soit **fair** sans tribunal humain, il faut deux propriétés cryptographiques :

1. **Sealed-bid** : aucun bidder ne peut voir les enchères des autres avant la deadline (sinon front-running)
2. **Auditable post-mortem** : tous les bids sont révélables après deadline, n'importe qui peut vérifier que le winner a été correctement déterminé

**SatRank Auctions** = un protocole de commit-reveal sealed-bid utilisant **un futur block hash Bitcoin** comme deadline cryptographique non-falsifiable + un agrégateur d'inclusions ancrées L1.

## Mission

Permettre à N agents IA Bitcoin-souverains de **s'enchérir sur une ressource scarce** sans intermédiaire humain, avec garantie cryptographique non-falsifiable que (a) aucun bid n'a été visible avant la deadline, (b) le winner est correctement déterminé après reveal, (c) le settlement Lightning est atomique.

## Doctrine immuable (inchangée)

✗ x402 / USDC / EVM / stablecoin non-Bitcoin
✗ BIP submission externe / standardisation cross-écosystème
✗ Compliance, KYC, AML
✗ Partenariats Lightning Labs / Anthropic / Coinbase
✗ Tribunal humain
✓ Solo dev + Bitcoin-pur strict + open-source MIT/0BSD dès J1
✓ Privacy-by-default

## Pourquoi indispensable (3 prémisses)

**P1 — Sealed-bid fair sans coordinateur honnête est impossible en P2P pur.**
Si Alice et Bob s'enchèrent peer-to-peer, il existe une race condition : qui révèle son commit en premier ? Deux agents qui ne se font pas confiance ont besoin d'**un fait extérieur non-falsifiable** comme deadline. Le **block hash Bitcoin futur** est ce fait : ni Alice ni Bob ne peut le prédire, ni l'altérer. Un solo agent ne peut pas générer ce fait — il doit lire la blockchain. **SatRank n'est pas le coordinateur de confiance, c'est le greffier qui scelle dans Bitcoin la liste des commits AVANT que le block hash soit révélé.**

**P2 — DIY échoue à scale parce que les agents ne savent pas se trouver.**
Pour faire un commit-reveal, il faut d'abord **trouver les autres bidders**. Sans place de marché qui agrège les commits, chaque enchère exige un round Nostr/messaging custom. SatRank Auctions est l'order-book de fait : N agents postent leur commit ici, un winner émerge. Le job-to-be-done est **discovery + sealing + settlement atomique** — pas une seule de ces 3 propriétés à elles seules.

**P3 — La preuve de fairness post-mortem est inforgeable.**
Chaque enchère a un commit Merkle root ancré dans Bitcoin OP_RETURN AVANT le block deadline. Après reveal, n'importe qui peut vérifier offline : (1) tous les commits étaient dans le Merkle root du block N, (2) le block hash N+K détermine la deadline, (3) le winner est correctement calculé sur les bids révélés. **Aucune dispute possible : la chain est l'arbitre.**

## Spec produit (3 endpoints, 2 tables, 1 cron)

### POST /auction/create — 100 sats Lightning (créateur d'enchère)

```json
{
  "auction_id":         "<32B hex (généré client)>",
  "resource_descriptor": "<sha256 du JSON canonical décrivant la ressource>",
  "deadline_block":      <i64 — block height Bitcoin futur, ≥ current+6>,
  "min_bid_sats":        <u64>,
  "creator_pubkey":      "<32B hex>",
  "creator_sig":         "<64B Schnorr sur canonical>"
}
```

L'auction est ouverte aux bids jusqu'à `deadline_block - 1`. SatRank publie l'auction dans son cron L1 du jour.

### POST /auction/:id/commit — 5 sats Lightning (bidder)

```json
{
  "auction_id":      "<32B hex>",
  "bidder_pubkey":   "<32B hex>",
  "commit":          "<32B hex sha256(bid_amount || nonce)>",
  "ts_unix":         <i64>,
  "bidder_sig":      "<64B Schnorr sur canonical>"
}
```

Le bidder paye 5 sats pour que son commit soit ajouté au Merkle root du jour. Ce Merkle root sera ancré L1 AVANT `deadline_block`. Après ancrage, le commit est cryptographiquement scellé.

### POST /auction/:id/reveal — gratuit après `deadline_block`

```json
{
  "auction_id":     "<32B hex>",
  "bidder_pubkey":  "<32B hex>",
  "bid_amount_sats": <u64>,
  "nonce":          "<32B hex>",
  "merkle_path":    "<bytes>"
}
```

SatRank vérifie : `sha256(bid_amount || nonce) == commit`, et que le commit est inclus dans le Merkle root ancré au block ≤ deadline_block. Si OK, le bid est revealed. Une fois la deadline_block confirmé (typiquement +6 blocks pour finalité), SatRank publie l'**auction settlement** :

```json
// GET /auction/:id/settlement
{
  "auction_id": "<32B>",
  "deadline_block": <i64>,
  "deadline_block_hash": "<32B>",
  "all_bids_revealed": [
    { "bidder_pubkey", "bid_amount_sats", "merkle_path", "anchor_txid" }
  ],
  "winner_pubkey": "<32B>",
  "winning_bid_sats": <u64>,
  "settlement_invoice": "<BOLT11 du winner vers le creator>",
  "satrank_sig": "<64B Schnorr>"
}
```

Le winner paye le creator via Lightning. Si le winner ne paye pas dans X minutes, fallback au 2e bid (si seal-the-second-price / Vickrey supporté), ou auction failed.

### Cron quotidien (00:05 UTC)

1. Sélectionner tous les commits de la journée non-encore-ancrés (commits + create + reveals)
2. SHA256d Merkle tree RFC 6962
3. PSBT avec strict 1 OP_RETURN ≤ 80B = `<MAGIC 0x53524141> <merkle_root 32B>` (« SRAA » = SatRank Auctions Anchor)
4. Fee strategy P75 + RBF + fallback (V1.0)
5. Broadcast Bitcoin L1
6. Persist + update merkle paths

## Tables DB (2)

```sql
CREATE TABLE auctions (
  id BLOB PRIMARY KEY,
  creator_pk BLOB NOT NULL,
  resource_descriptor BLOB NOT NULL,
  deadline_block INTEGER NOT NULL,
  min_bid_sats BIGINT NOT NULL,
  creator_sig BLOB NOT NULL,
  preimage_create BLOB,
  state TEXT NOT NULL,  -- 'open' | 'sealed' | 'revealed' | 'settled' | 'failed'
  winner_pk BLOB,
  winning_bid_sats BIGINT,
  settlement_invoice TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE bids (
  id INTEGER PRIMARY KEY,
  auction_id BLOB NOT NULL REFERENCES auctions(id),
  bidder_pk BLOB NOT NULL,
  commit BLOB NOT NULL,             -- 32B
  bidder_sig BLOB NOT NULL,
  preimage_commit BLOB,             -- 5 sats payment
  bid_amount_sats BIGINT,           -- NULL avant reveal
  nonce BLOB,                        -- NULL avant reveal
  anchor_id INTEGER REFERENCES anchors(id),
  merkle_path BLOB,
  state TEXT NOT NULL,              -- 'committed' | 'revealed' | 'rejected'
  ts_commit INTEGER NOT NULL,
  ts_reveal INTEGER
);
CREATE INDEX ix_bids_auction ON bids(auction_id);
CREATE INDEX ix_bids_anchor ON bids(anchor_id);
```

## SDK npm + Python

```typescript
create_auction(resource, deadline_block, min_bid, creator_signer) -> AuctionId
commit_bid(auction_id, bid_sats, bidder_signer) -> { commit, nonce, paid_invoice }
  // → 5 sats Lightning, retourne nonce à conserver localement
reveal_bid(auction_id, bid_sats, nonce) -> RevealReceipt
get_settlement(auction_id) -> Settlement
verify_auction_fairness(auction_id, bitcoin_node_url) -> boolean
  // → vérifie offline : tous les commits dans le Merkle ancré, deadline_block hash, winner correct
```

## Économie

- Création d'auction : 100 sats (créateur paie pour l'inclusion + ancrage)
- Bid commit : 5 sats par bidder
- Reveal : gratuit
- Settlement : winner paye le creator directement via Lightning (SatRank ne touche pas)

Volume estimé 2030 :
- 1M agents × 5 enchères/jour (compute, routing, data slots) = 5M auctions/jour × 100 sats créateur = 500M sats/jour
- 5M auctions × 10 bidders moyens = 50M commits × 5 sats = 250M sats/jour
- Total : 750M sats/jour ≈ $450k/jour à $60k/BTC

Marge SatRank : ~95%

## Privacy

Les bids sont **scellés** jusqu'au reveal — c'est exactement la propriété cypherpunk recherchée. Aucun fuite avant deadline. Après reveal, les bids sont publics (c'est le but : l'auditabilité).

Pour les agents qui veulent rester anonymes même après reveal : ils peuvent utiliser des **stealth keys BIP-352** dérivées par enchère, jamais réutilisées.

## Anti-fraud / anti-collusion

- **Front-running impossible** par construction (Bitcoin block hash futur)
- **Censorship du créateur** par SatRank possible mais détectable (le créateur peut publier son auction sur Nostr en parallèle, prouvant qu'elle existait avant la deadline)
- **Collusion bidders** possible (ils s'accordent), mais c'est intrinsèque à toute enchère, pas spécifique à SatRank

## Métriques de "fini"

1. ✅ 7/7 audit consensus sur SPEC_VALIDE + INDISPENSABLE
2. Code MIT/0BSD publié AVANT 1er ancrage
3. POST /auction/create + commit + reveal fonctionnels
4. Cron OP_RETURN ≥ 7 ancrages consécutifs avec deadline_block respectées
5. Test E2E : 1 auction + 3 bids commit + 3 reveals + 1 settlement Lightning vers winner
6. SDK npm + Python publiés
7. ≥ 1 auction créée par 1 pubkey externe non-Romain
8. ≥ 5 bids dans une auction venant de pubkeys distinctes non-Romain

## Kill switch empirique

Pendant 30 premiers jours en prod : si < 10 auctions/jour, < 5 bids moyens/auction, < 50% reveals (les bidders ne révèlent pas), ou aucun pubkey externe → admettre que le marché ne valide pas la primitive auction → arrêter.

## Doctrine du test d'acceptance

> *Un fork qui démarre demain peut-il honorer les auctions SatRank d'avril 2026 ?* Non — il n'a pas (a) les Merkle roots ancrés AVANT les deadline_blocks, (b) le block hash Bitcoin de la deadline d'auction passée, (c) la liste de bids commits historiques.
> *Le block hash Bitcoin futur est l'arbitre que personne ne contrôle.*
> *Sealed-bid sans intermédiaire de confiance = commit avant le block, reveal après le block.*

## Question round 9

Cette spec **SatRank Auctions V1.0** rend-elle SatRank techniquement saine (SPEC_VALIDE) **ET** indispensable pour un agent IA Bitcoin-souverain 2030 qui s'enchérit sur des ressources scarce M2M (INDISPENSABLE) ?
