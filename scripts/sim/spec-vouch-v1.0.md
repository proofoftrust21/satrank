# SatRank Vouch — spec V1.0 (candidat produit phare)

**Pivot complet R7 → R8** : abandon SatRank Routing (LDK/CLN trampoline le commodifient). Test d'un produit aux propriétés différentes — **un Cashu mint spécialisé pour la réputation agent**, où chaque "vouch" produit un bearer token transférable.

## Ce qu'est le produit

L'agent A peut **voucher** pour l'agent B contre paiement Lightning. SatRank émet alors un **Cashu blinded token** (NUT-00 standard) signé par SatRank, que l'agent B reçoit et porte dans son wallet Cashu. L'agent B peut présenter ces tokens à n'importe quel agent C comme **preuve bearer** qu'il a été vouché par d'autres agents.

Chaque token est :
- Cashu blinded (privacy par défaut — A ne peut pas tracer où B utilise son vouch)
- Transférable P2P (B peut donner ses vouch tokens à un autre agent ou à un consommateur)
- Vérifiable offline contre la pubkey publique du mint SatRank
- Ancré dans le keyset SatRank quotidien sur Bitcoin L1 OP_RETURN

## Mission

Permettre à un agent IA Bitcoin-souverain de **construire une réputation portable bearer** transférable P2P, vérifiable offline, sans permission, ancrée Bitcoin L1, **dans le format standard Cashu interopérable avec n'importe quel wallet Bitcoin de l'écosystème**.

## Doctrine immuable (inchangée)

✗ x402 / USDC / EVM / stablecoin non-Bitcoin
✗ BIP submission externe
✗ Compliance, KYC, AML
✗ Partenariats Lightning Labs / Anthropic / Coinbase
✗ Tribunal humain ou comité d'oracle
✓ Solo dev + Bitcoin-pur strict + open-source MIT/0BSD dès J1
✓ **Cashu standard NUT-00/01/02 — pas un format propriétaire**
✓ Privacy-by-default

## Pourquoi indispensable (3 prémisses)

**P1 — Bearer assets ≠ requête API.**
Un agent qui veut prouver son passé doit aujourd'hui faire un appel API à un service de réputation. Avec Vouch, l'agent **porte** sa réputation dans son wallet Cashu. Un nouveau partenaire de transaction reçoit les tokens directement P2P (Cashu transfer) — **pas de tiers à interroger en runtime**. Asymétrie : SatRank émet une fois, les tokens vivent leur vie. Vol/perte de tokens = perte de réputation (incentive à les conserver).

**P2 — Format Cashu standard = pas de fork facile.**
Un fork qui démarre demain peut faire son propre mint Cashu. Mais un agent qui a accumulé 1000 vouch tokens chez SatRank ne peut pas les "transférer" vers un autre mint — chaque mint a son propre keyset. Le moat = la **base installée de tokens en circulation** + l'interop avec wallets Cashu existants (Cashu.me, Minibits, Bull Bitcoin, etc.) qui reconnaissent SatRank comme mint trust-minimisé.

**P3 — Volume × volume = micropayment économie.**
Chaque interaction réussie entre agents = potentiellement 1 vouch émis. Pour 1M agents qui font 100 interactions/jour avec vouch optionnel à 50% = 50M vouchs/jour à 10 sats = 500M sats/jour. Marge 95%. Le volume n'a pas de limite supérieure structurelle. Volume × Cashu standard × ancrage L1 = effet de réseau composable.

## Spec produit (3 endpoints, 2 tables, 1 cron)

### POST /vouch — 10 sats Lightning

```json
// Input
{
  "voucher_pubkey":  "<32B hex x-only secp256k1 — la pubkey de A>",
  "vouchee_pubkey":  "<32B hex x-only secp256k1 — la pubkey de B>",
  "interaction_hash": "<32B hex — sha256 de l'interaction (Lightning preimage, opt)>",
  "weight":          1,                  // 1-10, weight de la vouch
  "ts_unix":         <i64>,
  "voucher_sig":     "<64B Schnorr BIP-340 sur canonical>",
  "blinded_message": "<33B hex Cashu B_ blinded message côté vouchee>"
}

// Output (immédiat post-paiement Lightning)
{
  "vouch_id":      "<32B hex>",
  "blinded_signature": "<33B hex C_ Cashu blinded signature>",
  "keyset_id":     "<8B hex Cashu keyset>",
  "anchor_eta":    <unix>,
  "invoice":       "<BOLT11 10 sats expiry < 60s>"
}
```

L'agent vouchee unblind localement et obtient un Cashu Proof :
```
Proof {
  amount: 1 (les vouch tokens sont des "1 unit" denomination),
  secret: <agreed nonce>,
  C: <unblinded signature>,
  id: <keyset_id>
}
```

Le proof est stocké dans son wallet Cashu standard. Il peut être :
- **Présenté** à un autre agent comme preuve de vouch (transfer Cashu)
- **Vérifié** offline en interrogeant la pubkey publique du keyset
- **Burn** (split + redeem) pour upgrader son tier de réputation

### POST /redeem — gratuit

L'agent peut redeem ses vouch tokens (= les invalider) pour obtenir une **attestation agrégée** signée Schnorr : `{ pubkey, total_vouchs_redeemed, weighted_score, anchor_block_height }`. Cette attestation est un bearer asset secondaire qu'il peut présenter sans révéler les tokens individuels.

### GET /keyset/:id — gratuit

Retourne la pubkey publique du keyset Cashu pour vérification offline. Standard Cashu NUT-01.

### Cron quotidien (00:05 UTC à choisir post-mainnet)

1. Calculer le hash du keyset actif du jour (rotation hebdomadaire pour minimiser blast radius)
2. Construire un Merkle tree de tous les `vouch_id` du jour + le hash du keyset
3. PSBT avec strict 1 OP_RETURN ≤ 80B = `<MAGIC 0x53524e56> <merkle_root 32B>` (« SRNV » = SatRank Vouch)
4. Fee strategy P75 + RBF + fallback (V1.0)
5. Broadcast Bitcoin L1
6. Persist + update merkle paths

L'ancrage L1 garantit que **un fork qui démarre J+30 ne peut pas créer des vouch tokens du jour D** (ils n'existent pas dans son Merkle ; et il n'a pas le keyset SatRank du jour D).

## Tables DB (2)

```sql
CREATE TABLE vouchs (
  id BLOB PRIMARY KEY,             -- 32B vouch_id
  voucher_pk BLOB NOT NULL,
  vouchee_pk BLOB NOT NULL,
  interaction_hash BLOB,
  weight INTEGER NOT NULL,
  voucher_sig BLOB NOT NULL,
  blinded_message BLOB NOT NULL,
  blinded_signature BLOB NOT NULL,  -- Cashu C_
  keyset_id BLOB NOT NULL,
  preimage BLOB UNIQUE,             -- Lightning 10 sats
  anchor_id INTEGER REFERENCES anchors(id),
  merkle_path BLOB,
  ts_unix INTEGER NOT NULL,
  redeemed_at INTEGER              -- NULL si non-redeemed
);
CREATE INDEX ix_vouch_voucher ON vouchs(voucher_pk, ts_unix);
CREATE INDEX ix_vouch_vouchee ON vouchs(vouchee_pk, ts_unix);

CREATE TABLE anchors (
  id INTEGER PRIMARY KEY,
  merkle_root BLOB NOT NULL,
  btc_txid BLOB,
  btc_block INTEGER,
  count INTEGER NOT NULL,
  keyset_id BLOB NOT NULL,
  anchored_at INTEGER NOT NULL,
  fee_sat_vb INTEGER NOT NULL,
  rbf_attempts INTEGER NOT NULL DEFAULT 0
);
```

## SDK npm + Python — Cashu native

```typescript
import { CashuMint, CashuWallet, getEncodedToken } from '@cashu/cashu-ts';

vouch_for(voucher_pk, vouchee_pk, weight, interaction_hash) -> CashuToken
  // → 10 sats Lightning, retourne Cashu Proof standard
  // → l'agent vouchee unblind localement et stocke dans son wallet
  
redeem_for_attestation(proofs[]) -> AggregateAttestation
  // → invalide les proofs, retourne attestation agrégée Schnorr-signed

verify_vouch_token(proof, satrank_keyset_url) -> bool
  // → 100% client-side via Cashu.cashuts standard

verify_aggregate_attestation(attestation, bitcoin_node_url)
  // → vérifie signature Schnorr + Merkle inclusion L1 + headers
  // → 100% offline, pas de dépendance satrank.dev
```

L'agent peut utiliser **n'importe quel wallet Cashu existant** (Cashu.me, Minibits, Nutstash, Bull Bitcoin) pour stocker ses tokens. Pas de wallet SatRank propriétaire.

## Économie

- **10 sats / vouch** = ~$0.006 à $60k/BTC
- Volume estimé 2030 (bear) : 1M agents × 10 vouch/jour = 10M vouchs/jour = 100M sats/jour ≈ $60k/jour
- Volume estimé 2030 (bull) : 10M agents × 100 vouch/jour = 1G vouchs/jour = 10G sats/jour ≈ $6M/jour
- Marge SatRank : ~95%
- Coût observer (vouchee) : 0 sat (juste paye le keyset rotation cost amorti)
- Coût voucher (qui paye 10 sats) : son investissement dans la réputation de la contre-partie

## Privacy

- Cashu blinded = SatRank ne sait pas qui détient quel proof (BDHKE blinding standard)
- Vouchee peut **transfer P2P** ses proofs à un tiers qui les vérifie offline contre keyset SatRank — SatRank n'est jamais interrogé
- L'historique de vouch lié à `voucher_pk` est public sur Bitcoin L1 (OP_RETURN merkle root) mais le détail n'est pas trivialement déchiffrable sans interroger SatRank.dev (ou maintenir un mirror local des merkle leaves)

## Anti-sybil

- Le voucher paye 10 sats pour voucher → coût économique réel à émettre du sybil
- Si A "vouche" pour B 1000 fois pour fabriquer une faux historique, A a brûlé 10 000 sats
- Les heuristiques côté consommateur (V1.0+) s'appliquent : counterparty diversity (combien de vouchers distincts B a-t-il ?), burn-rooted distance (le voucher A est-il lui-même vouched par d'autres?), time-anchored age

## Phase B (déclenchée par métriques)

Une fois ≥ 1M tokens en circulation, ajouter une **bourse de tokens** où les agents peuvent acheter/vendre des vouch tokens P2P (Cashu standard supporte le transfer). Volume × volume.

## Métriques de "fini"

1. ✅ 7/7 audit consensus sur SPEC_VALIDE + INDISPENSABLE
2. Code MIT/0BSD publié AVANT 1er ancrage
3. POST /vouch fonctionnel, retourne Cashu Proof standard
4. Cron OP_RETURN ≥ 7 ancrages consécutifs avec keyset rotation
5. Test E2E : 1 vouch + 1 paiement Lightning + 1 unblind par vouchee + 1 vérification offline d'un wallet Cashu tiers
6. SDK npm + Python publiés
7. ≥ 1 vouch payé par 1 pubkey externe non-Romain
8. ≥ 1 wallet Cashu tiers (Cashu.me / Minibits / etc.) reconnaît SatRank Vouch comme mint valide

## Kill switch empirique

Pendant 30 premiers jours en prod : si < 100 vouchs/jour, < 5 pubkeys externes non-Romain, ou aucun wallet Cashu tiers ne reconnaît SatRank → admettre que le marché ne valide pas la primitive bearer-réputation → arrêter.

## Doctrine du test d'acceptance

> *Un fork qui démarre demain peut-il honorer les vouch tokens SatRank de mai 2026 ?* Non — il n'a pas le keyset SatRank, et il n'a pas l'OP_RETURN d'ancrage du jour D.
> *La réputation est un bearer asset, pas une requête API.*

## Question round 8

Cette spec **SatRank Vouch V1.0** rend-elle SatRank techniquement saine (SPEC_VALIDE) **ET** indispensable pour un agent IA Bitcoin-souverain 2030 qui veut construire et porter une réputation transférable bearer (INDISPENSABLE) ?
