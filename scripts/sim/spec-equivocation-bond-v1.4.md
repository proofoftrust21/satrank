# SatRank Equivocation Bond — spec V1.4 (fix MEV race)

**R15 = 6/7 SPEC + 4/7 INDISP + 4/7 OUI/OUI** — record sur 15 rounds. V1.4 fixe le seul vrai blocker technique restant.

## Fix R15 — MEV race au slashing (devil's advocate)

### Le bug V1.3

Le revealer extrait `x` à partir des deux signatures contradictoires, mais avant qu'il broadcast la TX de slashing, **n'importe qui qui voit les deux signatures peut aussi extraire `x`** — y compris les mineurs qui peuvent frontrunner. Le revealer original peut perdre la prime contre un miner qui voit la mempool TX et substitue la sienne.

### Fix V1.4 — workflow strict du SDK + timelock CSV

**Workflow correct du SDK revealer** (privacy-by-default) :

1. Le revealer détecte localement les deux signatures contradictoires (via /scan ou via observation directe Nostr)
2. Le revealer extrait `x` localement
3. Le revealer signe une TX qui dépense le bond UTXO vers son propre wallet — **avec un timelock CSV de N blocs** (par exemple 6 blocs ≈ 1h)
4. Le revealer broadcast la TX **sans publier les sigs sur Nostr**
5. Pendant les 6 blocs CSV, personne d'autre ne peut spendre l'UTXO (locktime)
6. Après confirmation : le revealer peut publier les sigs sur Nostr (récompense réputationnelle, signal de la fraude)

Le **CSV (CHECKSEQUENCEVERIFY)** est un opcode Bitcoin actif depuis 2016 (BIP-112). Il permet de verrouiller un UTXO pendant N blocs après création. C'est exprimable dans un script Taproot script-path.

### Construction Taproot mise à jour

Le bond UTXO a maintenant deux paths :
- **key-path** : `agent_pubkey` (l'agent peut retirer son bond après expiration)
- **script-path** : `<6 OP_CSV OP_DROP> <agent_pubkey> OP_CHECKSIG` — anyone-can-spend après 6 blocs, signature avec `x` requise

Le revealer signe via script-path avec `x` + délai CSV de 6 blocs minimum. **Aucun frontrun possible** dans cette fenêtre — le revealer original a 6 blocs d'avance pour broadcast.

Si plusieurs revealers détectent l'équivocation simultanément, le premier à broadcast gagne (race normale, mais pas MEV miner-frontrunning sur le contenu publié).

### Référence

- **BIP-112** (OP_CSV) — actif Bitcoin mainnet depuis 2016
- **Taproot script-paths** — actif depuis nov 2021
- Standard et battle-tested

## Doctrine immuable (inchangée)

✗ x402 / USDC / EVM / stablecoin non-Bitcoin
✗ BIP submission externe
✗ Compliance, KYC, AML
✗ Partenariats Lightning Labs / Anthropic / Coinbase
✗ Tribunal humain ou comité d'oracle
✗ Cohabitation V1/V2
✓ Solo dev + Bitcoin-pur strict + open-source MIT/0BSD dès J1
✓ Privacy-by-default

## Cible (assumée niche, c'est OK)

Inchangée V1.3 — escrows engageants non-atomiques (DLC, sealed-bid, oracle votes, compliance attestations, DAO binding votes). 10-20% des transactions M2M mais slot critique non-substituable par HTLC atomique.

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
  "deposit_psbt":      "<PSBT signée par l'agent>",
  "agent_sig":         "<64B Schnorr>"
}
```

Le bond UTXO est verrouillé en Taproot avec :
- key-path = `agent_pubkey` (retrait après expiration)
- script-path = `[6 OP_CSV OP_DROP <agent_pubkey> OP_CHECKSIG]` (anyone-can-spend après 6 blocs, sig avec x requise)

```json
// Output
{
  "bond_id":              "<32B>",
  "deposit_txid":         "<32B>",
  "deposit_block_height": <i64>,
  "taproot_internal_key": "<32B>",
  "script_path_hash":     "<32B>"
}
```

### POST /slashing/submit — gratuit (n'importe qui)

Inchangé V1.3. SatRank publie via Nostr l'extraction de `x` **APRÈS** que le revealer a broadcast sa TX de slashing avec CSV (vérifie le mempool d'abord). Cela évite la race MEV.

Alternative : le SDK gère localement la séquence extract → broadcast → publish. Le revealer rationnel ne publie pas d'abord.

### POST /scan/:domain_tag — 1 sat Lightning

Inchangé V1.3.

### GET /pool/:domain_tag — gratuit

Inchangé V1.3.

### Cron quotidien

Inchangé V1.0.

## Tables DB (2)

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
  taproot_internal_key BLOB NOT NULL,
  script_path_hash BLOB NOT NULL,
  state TEXT NOT NULL,
  slashed_txid BLOB,
  slashed_at_block INTEGER,
  slashed_by_pubkey BLOB,
  extracted_x BLOB,
  anchor_id INTEGER REFERENCES anchors(id),
  merkle_path BLOB,
  posted_at INTEGER NOT NULL
);
CREATE INDEX ix_bonds_domain ON bonds(domain_tag, state);
CREATE INDEX ix_bonds_R ON bonds(R_bond);

CREATE TABLE anchors (...) -- inchangé V1.0
```

## SDK npm + Python

```typescript
import { EquivocationBond } from '@satrank/equiv-bond';

post_bond(agent_pk, amount_sats, domain_tag, duration_blocks, signer)
  -> { bond_id, R_bond, deposit_txid, taproot_internal_key }

sign_for_domain(agent_pk, domain_tag, payload, R_bond, signer)
  -> { sig: (R_bond, s) }
  // SDK refuse signing 2 payloads avec même R_bond pour même domain_tag

submit_slashing_proof(bond_id, sig_1, msg_1, sig_2, msg_2, submitter_signer)
  // INCHANGÉ : extract x localement, ne PAS publier sur Nostr
  -> { x_extracted, tx_template_with_csv_lock }

broadcast_slashing_tx(tx_template_with_csv_lock, x, recipient_address, bitcoin_node_url)
  // Sign et broadcast la TX avec script-path + CSV 6-block lock
  -> { bitcoin_txid, csv_unlock_block }

publish_equivocation_to_nostr(sig_1, msg_1, sig_2, msg_2, after_csv_unlock)
  // Appelé APRÈS confirmation de la TX de slashing — récompense réputationnelle
  // Nostr event kind 3xx avec les sigs publiques

verify_bond_active_offline(bond_id, bitcoin_node_url) -> bool

scan_for_equivocations(domain_tag, since_block, scanner_signer)
  -> { active_bonds, candidates_with_double_sig }
  // 1 sat Lightning
```

## Économie

Inchangée V1.3. Volume estimé 2030 niche.

## Privacy

Inchangée V1.3.

## Anti-fraud

- **Math = juge** (extraction Schnorr nonce-reuse)
- **CSV protège du MEV race** (6 blocs d'avance pour le revealer)
- **SatRank sans pouvoir cryptographique** (publie info post-broadcast)
- **Open-source MIT** (broadcast direct possible, satrank.dev substituable)

## Ce qui rend ça non-DIY

Inchangé V1.3 — standard `domain_tag`, pool agrégé, index searchable, convention SDK.

## Métriques de "fini"

1. ✅ ≥ 6/7 SPEC_VALIDE + ≥ 5/7 INDISPENSABLE (cible R16, primitive niche acceptée)
2. Code MIT/0BSD publié AVANT 1er ancrage
3. Endpoints fonctionnels
4. Cron OP_RETURN ≥ 7 ancrages consécutifs
5. **Test E2E crypto avec CSV** : bond posté + équivocation + extraction x + broadcast TX avec CSV lock + 6 blocs d'attente + confirmation + publication post-confirmation
6. SDK npm + Python publiés
7. ≥ 1 bond externe non-Romain
8. ≥ 1 slashing réussi par bounty hunter externe

## Doctrine du test d'acceptance

> *Math = juge. CSV = protection contre miner MEV-frontrunning. Le revealer rafle 100% en 6 blocs.*
> *Bond Taproot dual-path (key + script) = exprimable Bitcoin Script standard, BIP-112 + Taproot mainnet depuis 2021.*

## Question round 16

Cette spec **SatRank Equivocation Bond V1.4** :
- **Crypto correcte** (extraction Schnorr nonce-reuse standard)
- **MEV race fixée** (CSV 6 blocs Taproot script-path + workflow SDK extract→broadcast→publish)
- **Cible niche assumée** (escrows engageants non-atomiques)
- **Lens A4 + A7 reformulés** pour juger du POV cible spécifique

…rend-elle SatRank techniquement saine (SPEC_VALIDE = ≥6/7) **ET** indispensable pour les agents 2030 dans son slot ciblé (INDISPENSABLE = ≥5/7) ?
