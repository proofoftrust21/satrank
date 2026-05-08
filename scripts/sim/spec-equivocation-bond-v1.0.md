# SatRank Equivocation Bond — spec V1.0 (issue du brainstorm 7/7 READY)

**Origine** : convergence cristalline de **6 agents Opus 4.7 sur 7** au round brainstorm 2 vers la même primitive sous 6 noms (DEVIL: ECB / CYPHER: EBCP / ARCH: SELFPUB_EQUIV_MESH / MAXI: ESBP / AGENT: MEB / LSP: MEV_BOND). 7/7 READY_TO_VOTE_INDISPENSABLE après le brainstorm. 7e agent (cypherpunk) a son top sur VDF Time-Vault — primitive sœur, à shipper en V2.

## Ce qu'est le produit

Un **pool de bonds Bitcoin Taproot** où chaque agent verrouille N sats. Le slashing est déclenché **mécaniquement** par n'importe qui qui présente **deux signatures Schnorr contradictoires** de la pubkey bondée sur le même `domain_tag` standardisé. SatRank n'a **aucune clé** dans la boucle critique — seulement un rôle de standardiseur de format + indexer + greffier d'ancrage L1.

Le moat = (a) **standard canonique de `domain_tag`** = effet Schelling non-DIY-able (un seul format utile, les forks meurent), (b) **masse de capital agrégée** = network effect économique (un solo bond vaut N sats, le pool vaut M×N sats), (c) **bounty hunters incentivés** = défense distribuée à coût zéro pour SatRank.

## Mission

Permettre à un agent IA Bitcoin-souverain de **prouver "je serai détruit financièrement si j'équivoque"** à un inconnu, sans tribunal, sans comité, sans signature opérateur — uniquement par script Taproot + adaptor signature pré-signée par l'agent lui-même.

## Doctrine immuable (inchangée)

✗ x402 / USDC / EVM / stablecoin non-Bitcoin
✗ BIP submission externe / standardisation cross-écosystème
✗ Compliance, KYC, AML
✗ Partenariats Lightning Labs / Anthropic / Coinbase
✗ **Tribunal humain ou comité d'oracle (rejet absolu)**
✗ Cohabitation V1/V2
✓ Solo dev + Bitcoin-pur strict + open-source MIT/0BSD dès J1
✓ Privacy-by-default

## Pourquoi indispensable (3 prémisses convergentes 7/7)

**P1 — Math = juge, pas SatRank.**
Le slashing est déclenché par script Taproot pur : `script-path = "anyone-can-spend si présentation de (sig1, sig2) où sig1 et sig2 sont deux signatures Schnorr valides par la même pubkey bondée sur le même domain_tag mais des messages contradictoires"`. La transaction de slashing est **pré-signée par l'agent lui-même** au moment du dépôt du bond (template fixe : 50% burn OP_RETURN + 50% bounty au revealer). Aucune clé SatRank requise. **C'est code is law au sens littéral**. Aucune des 5 alternatives DIY proposées par les agents au round 11 (HTLC probe direct, hold-invoice, OTS+Schnorr local) ne peut reproduire cette mécanique — elles n'ont pas de slashing automatique.

**P2 — La masse économique du pool n'est pas DIY-able.**
Un agent solo bond 1M sats = signal de 1M sats à ses contre-parties uniquement. La valeur cypherpunk vient de **la masse économique TOTALE du pool partagé** + **le standard `domain_tag` reconnu par tous les autres agents**. Une lib open-source reproduit le script Taproot ; ne reproduit pas la masse de capital ni la canonicité du format. C'est un **effet de réseau d'agrégation économique** (Hayek : competition as discovery procedure), pas un protocole logiciel. Bootstrap = Romain pose un bond initial public + crée le standard `domain_tag`.

**P3 — Slashing sans tribunal = doctrine cypherpunk pure.**
Eric Hughes 1993 : *"We must defend our own privacy if we expect to have any."* Le slashing par double-sig est une **équation algébrique** (BIP-340 + canonical message_class), exécutable par n'importe quel mempool relay sans permission. Aucune signature SatRank, aucun comité, aucun arbitre. La pré-signature adaptor de l'agent au moment du bond garantit que **l'agent lui-même** consentit aux conditions de slashing avant tout litige. C'est l'antithèse cypherpunk du tribunal centralisé du round 11.

## Spec produit (3 endpoints, 2 tables, 1 cron)

### POST /bond/post — frais Lightning + dépôt L1

```json
// Input
{
  "agent_pubkey":      "<32B hex x-only secp256k1>",
  "bond_amount_sats":  <u64 ≥ 100_000>,
  "domain_tag":        "<UTF-8 canonical, max 64B>",  // ex: "auction-12345-winner"
  "duration_blocks":   <i64 ≥ 144>,
  "deposit_psbt":      "<hex base64 PSBT signée par l'agent>",
  "slashing_template_sig": "<64B Schnorr adaptor sur le template TX standardisé>",
  "agent_sig":         "<64B Schnorr sur canonical(input)>"
}
```

Le `slashing_template_sig` est l'adaptor signature pré-signée par l'agent sur le template canonical de TX de slashing : `[input = ce_bond_utxo, output_1 = OP_RETURN burn 50%, output_2 = anyone-can-spend 50% pour le revealer]`. Le revealer remplace l'adaptor avec la révélation de la double-sig pour finaliser la signature.

```json
// Output (après broadcast L1)
{
  "bond_id":              "<32B>",
  "deposit_txid":         "<32B>",
  "deposit_block_height": <i64>,
  "slashing_template":    "<hex PSBT canonical>",
  "anchor_eta_block":     <i64>
}
```

L'agent est maintenant dans le pool indexé avec son `domain_tag`. Frais SatRank : 0.3% annualisé du bond, prélevé en sats Lightning à l'ouverture (one-shot).

### POST /slashing/submit — gratuit (n'importe qui)

```json
// Input
{
  "bond_id":         "<32B>",
  "sig_1":           "<64B Schnorr de la pubkey bondée>",
  "msg_1":           "<canonical (domain_tag, payload_a)>",
  "sig_2":           "<64B Schnorr de la pubkey bondée>",
  "msg_2":           "<canonical (domain_tag, payload_b)>",
  "submitter_pubkey": "<32B hex>"
}
```

SatRank vérifie cryptographiquement :
- `verify_schnorr(agent_pubkey, msg_1, sig_1) == true`
- `verify_schnorr(agent_pubkey, msg_2, sig_2) == true`
- `domain_tag(msg_1) == domain_tag(msg_2) == bond.domain_tag`
- `msg_1.payload != msg_2.payload` (équivocation prouvée)

Si OK : SatRank **publie** la double-sig + le slashing PSBT finalisable via Nostr et expose dans son index. **N'importe quel agent peut alors finaliser la TX de slashing** en utilisant la double-sig comme révélation de l'adaptor + broadcast on-chain. Le bond est slashé : 50% burn OP_RETURN, 50% au submitter.

**SatRank ne broadcast pas la TX de slashing.** Il publie uniquement la preuve. Les bounty hunters broadcast.

### GET /pool/:domain_tag — gratuit

Retourne la liste des bonds actifs dans ce domain_tag : `[{bond_id, agent_pubkey, bond_amount, deposit_block_height, expires_block, state}]`. Permet à un agent A qui considère transactor avec B sur `domain_tag = "auction-12345"` de vérifier que B a un bond actif suffisant.

### Cron quotidien (00:05 UTC)

1. SELECT tous les nouveaux bonds + slashings du jour
2. SHA256d Merkle tree RFC 6962
3. PSBT avec strict 1 OP_RETURN ≤ 80B = `<MAGIC 0x53524542> <merkle_root 32B>` (« SREB » = SatRank Equivocation Bond)
4. Fee strategy P75 + RBF + fallback
5. Broadcast Bitcoin L1
6. Persist + update merkle paths

L'ancrage L1 fournit l'audit ex-post inforgeable du pool historique.

## Tables DB (2)

```sql
CREATE TABLE bonds (
  id BLOB PRIMARY KEY,                    -- 32B bond_id
  agent_pk BLOB NOT NULL,
  bond_amount_sats BIGINT NOT NULL,
  domain_tag TEXT NOT NULL,
  duration_blocks INTEGER NOT NULL,
  deposit_txid BLOB NOT NULL,
  deposit_block_height INTEGER NOT NULL,
  expires_block INTEGER NOT NULL,
  slashing_template_sig BLOB NOT NULL,    -- adaptor sig pré-signée par l'agent
  state TEXT NOT NULL,                    -- 'active' | 'slashed' | 'expired' | 'withdrawn'
  slashed_txid BLOB,
  slashed_at_block INTEGER,
  slashed_by_pubkey BLOB,                 -- le revealer
  anchor_id INTEGER REFERENCES anchors(id),
  merkle_path BLOB,
  posted_at INTEGER NOT NULL
);
CREATE INDEX ix_bonds_domain ON bonds(domain_tag, state);
CREATE INDEX ix_bonds_agent ON bonds(agent_pk, state);

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

## SDK npm + Python — pure crypto

```typescript
import { EquivocationBond } from '@satrank/equiv-bond';

post_bond(agent_pk, amount_sats, domain_tag, duration_blocks, signer)
  -> { bond_id, deposit_txid, slashing_template }

submit_slashing(bond_id, sig_1, msg_1, sig_2, msg_2, submitter_signer)
  -> { slashing_psbt_finalizable, bounty_amount }

finalize_slashing_tx(slashing_psbt_finalizable, double_sig_revelation)
  -> bitcoin_tx_broadcastable

verify_bond_active_offline(bond_id, bitcoin_node_url)
  -> bool

scan_pool_for_equivocations(domain_tag, bitcoin_node_url)
  -> [{ bond_id, sig_1, sig_2, bounty_sats }]   // bounty hunter helper
```

Le SDK est 100% open-source MIT, utilisable par n'importe quel agent sans interroger satrank.dev pour la finalisation.

## Standard `domain_tag` (le Schelling point)

SatRank publie et maintient le **format canonique** de `domain_tag` que tous les agents s'engagent à respecter. Format strict :

```
domain_tag := "<category>-<context_id>-<role>"
  category : ascii-lower-snake [a-z0-9_]+
  context_id : 32 hex
  role : ascii-lower-snake [a-z0-9_]+
```

Exemples :
- `"auction-7f3a2b...-winner"` (pour sealed-bid auctions)
- `"escrow-9c1d4e...-fulfiller"` (pour escrows multi-step)
- `"oracle-2e5f8a...-attestation"` (pour oracle votes)
- `"reputation-pubkey1234...-month_2026_06"` (pour réputation périodique)

L'agent qui signe `(domain_tag, payload_a)` puis plus tard `(domain_tag, payload_b)` avec **payload_a ≠ payload_b** prouve son équivocation sur ce contexte. Le script Taproot accepte la double-sig comme preuve.

**Le standard est SatRank's seul moat non-économique** : un fork qui invente un format alternatif fragmente le marché ; les agents convergent sur le standard SatRank par effet Schelling.

## Économie

- **Bond minimum 100k sats** = ~$60 à $60k/BTC (anti-sybil)
- **Frais ouverture 0.3% annualisé** = 300 sats/jour pour 100k bond
- **Slashing 50% burn + 50% bounty** = incitation économique massive aux bounty hunters
- Volume estimé 2030 :
  - 50-100k bonds actifs (Devil's brainstorm estimate)
  - 50 slashings/jour à 1M sats moyens = 25M sats burned + 25M sats bounty/jour
  - Frais SatRank : 100k bonds × 300 sats/jour = 30M sats/jour ≈ $18k/jour
- Marge : ~95%

## Privacy

- Le bond on-chain leak `agent_pubkey` + `domain_tag` — solution V1.1 : MuSig2 multi-pubkey bonds (le bond est partagé par k agents, slashing si l'un d'eux équivoque)
- Le `domain_tag` peut être hashé pour leak minimal — V1.1
- V1.0 : transparence assumée pour bootstrap simplicité

## Anti-fraud / résistance à l'attaque

- **SatRank ne peut pas slash injustement** : aucune clé privée dans la boucle critique
- **SatRank ne peut pas protéger un tricheur** : le script Taproot est public, n'importe qui peut soumettre la double-sig
- **SatRank ne peut pas censurer** : le SDK permet la submission directe au mempool sans passer par satrank.dev
- **SatRank peut censurer son index searchable** : mais alors les agents fork-deploy un index alternatif (open-source MIT)

Le rôle SatRank est strictement **passif et substituable**. C'est exactement la doctrine cypherpunk pure.

## Métriques de "fini"

1. ✅ 7/7 audit consensus sur SPEC_VALIDE + INDISPENSABLE (cible round 12)
2. Code MIT/0BSD publié AVANT 1er ancrage public
3. POST /bond/post + slashing/submit + GET /pool fonctionnels
4. Cron OP_RETURN ≥ 7 ancrages consécutifs avec slashing TX broadcastées par bounty hunters
5. Test E2E : 1 bond + simulation d'équivocation + 1 slashing TX broadcasté par revealer non-Romain + 1 vérification offline
6. SDK npm + Python publiés
7. ≥ 1 bond posté par 1 pubkey externe non-Romain
8. ≥ 1 slashing réussi par un bounty hunter externe non-Romain (le test ultime de la primitive)

## Kill switch empirique

Pendant 30 premiers jours en prod : si < 5 bonds postés externes, 0 slashing réussi par bounty hunter externe → admettre que le marché ne valide pas la primitive → arrêter.

## Doctrine du test d'acceptance

> *Un fork qui démarre demain peut-il honorer les bonds SatRank d'avril 2026 ?* Non — il n'a pas (a) le pool économique agrégé, (b) le standard `domain_tag` reconnu par les agents, (c) l'historique L1 ancré.
> *Le slashing est une équation algébrique, pas une décision. Le mempool est le tribunal. Math protects.*
> *Reputation must be costly to acquire.* — Tim May, 1988

## Question round 12 audit-converge

Cette spec **SatRank Equivocation Bond V1.0**, issue de la convergence 6/7 au round brainstorm 2, rend-elle SatRank techniquement saine (SPEC_VALIDE) **ET** indispensable pour un agent IA Bitcoin-souverain 2030 qui veut prouver "skin-in-the-game cryptographique" à un inconnu sans tribunal (INDISPENSABLE) ?
