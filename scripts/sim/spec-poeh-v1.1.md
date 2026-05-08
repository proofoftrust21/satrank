# SatRank PoEH — spec V1.1 (privacy-preserving)

**Changements vs V1.0** :
- **Fix blocker A2 (privacy cypherpunk)** : commitments cryptographiques sur L1 au lieu de pubkeys/montants en clair. *Privacy is the power to selectively reveal* (Hughes) → l'agent révèle son passé à qui il veut, quand il veut. Les attestations sont **cryptographiquement liées** mais **publiquement opaques** par défaut.
- Reformulation des angles d'agents pour juger l'indispensabilité du POV de la **cible** (agent IA Bitcoin-souverain 2030), pas du métier propre de l'agent juge.

## Mission inchangée

Fournir une primitive cryptographique permettant à un agent Bitcoin souverain de **prouver son passé économique** à un inconnu, sans permission, sans intermédiaire de confiance unique, vérifiable offline contre Bitcoin L1. **La révélation est sélective** : l'agent contrôle qui voit quoi.

## Doctrine immuable

✗ x402 / USDC / EVM / stablecoin non-Bitcoin
✗ BIP submission / standardisation cross-écosystème
✗ Compliance, KYC, AML
✗ Partenariats Lightning Labs / Anthropic / Coinbase
✗ Tribunal humain ou comité d'oracle
✗ Cohabitation V1/V2
✓ Solo dev + Bitcoin-pur strict + open-source MIT/0BSD obligatoire dès J1
✓ **Privacy-by-default — Hughes' Cypherpunk Manifesto compliant**

## Architecture forkable multi-opérateur (inchangé V1.0)

Code MIT/0BSD publié AVANT premier ancrage public. N'importe qui fait tourner son propre opérateur. SatRank.dev = un parmi N possibles. `observer_pubkey` libre.

## Spec produit — privacy-preserving (changement majeur)

### POST /attest — 10 sats Lightning

**Input** RFC 8785 JCS canonical-JSON :

```json
{
  "v": 2,
  "payer_commit":      "<32B hex SHA256(payer_pk || payer_nonce)>",
  "payee_commit":      "<32B hex SHA256(payee_pk || payee_nonce)>",
  "amount_commit":     "<32B hex SHA256(amount_sats || amount_nonce)>",
  "payment_hash":      "<32B hex Lightning HTLC hash, public — non-secret>",
  "service_commit":    "<32B hex SHA256(service_tag || service_nonce)>",
  "ts_unix":           <i64>,
  "cosig_payer":       "<64B hex Schnorr BIP-340 sur sha256(canonical(input))>",
  "cosig_payee":       "<64B hex Schnorr BIP-340 — REQUIRED>",
  "observer_pubkey":   "<32B hex>",
  "observer_sig":      "<64B hex Schnorr>"
}
```

**Règles invariantes** :

1. `cosig_payer` ET `cosig_payee` valides Schnorr sur le canonical (calculées par le payer/payee qui connaissent leurs nonces et clés réelles). Sans cosig_payee → HTTP 400.
2. **Aucune pubkey, aucun montant, aucun service_tag en clair sur le serveur ni dans le Merkle root ancré L1.** Que des commitments SHA256.
3. Les nonces (`payer_nonce`, `payee_nonce`, `amount_nonce`, `service_nonce`) sont **détenus uniquement par les parties cosignataires**. Ils ne sont jamais transmis à SatRank.
4. **Révélation sélective** : pour prouver son passé à un tiers spécifique T, l'agent A fournit à T : `(observation_id, payer_pk, payer_nonce, amount_sats, amount_nonce, service_tag, service_nonce)` + Merkle path. T vérifie : `SHA256(payer_pk || payer_nonce) == payer_commit`, etc. Le lien entre A et l'observation est révélé seulement à T.
5. Tant qu'aucune révélation n'a lieu, l'observation L1 est cryptographiquement opaque pour le monde.

**Conséquence cypherpunk** : un attaquant qui scrape Bitcoin L1 + le serveur SatRank ne peut PAS reconstruire le graphe économique des agents. Il voit `N millions de commitments SHA256 ancrés`. Aucune information dérivable sans préimage.

### Anti-sybil — proof-of-burn L1 inchangé

Burn ≥ 10 000 sats vers OP_RETURN Bitcoin pour pubkey "verified". L'attestation de burn est elle-même une attestation PoEH avec `service_tag = "poeh:burn"` (commitments). Le préimage du burn doit être révélé publiquement par l'agent pour que sa pubkey soit visiblement burned (révélation volontaire).

### GET /proof/:observation_id — gratuit

Retourne `{ observation_id, anchor: { merkle_root, btc_txid, block_height, block_hash }, merkle_path: [...], leaf: <canonical(input_with_commits)> }`. Pas de pubkey, pas de montant. Tiers vérifie l'inclusion L1 sans rien apprendre.

### GET /endpoint/:pubkey?since=:block — gratuit, mais nécessite révélation

Comme les pubkeys ne sont pas en clair sur le serveur, cet endpoint est inutile sans révélation. Réécrit :

**`POST /reveal_history`**

Input :
```json
{
  "queried_pubkey": "<32B hex>",
  "selective_proofs": [
    { "observation_id", "pubkey", "nonce", "role" /* "payer" | "payee" */ }
  ]
}
```

L'agent prouve qu'il connaît les nonces de N attestations impliquant `queried_pubkey`. Le serveur vérifie `SHA256(pubkey || nonce) == commit`. Si OK, retourne les `{observation_id, anchor_proof}` correspondants pour ces N attestations.

Le **tiers vérifieur reçoit la révélation directement de l'agent**, pas du serveur. Le serveur PoEH n'est qu'un index Merkle public — il ne sait jamais qui est qui.

### Cron quotidien (inchangé V1.0)

OP_RETURN ≤ 80B = `<MAGIC 0x53524b32> <merkle_root 32B>` = 36B. Strict, RBF, fallback, monitoring.

## Tables DB

```sql
CREATE TABLE observations (
  id BLOB PRIMARY KEY,             -- 32B sha256(canonical_jcs_input)
  payload BLOB NOT NULL,           -- canonical_jcs intégral (que des commitments)
  preimage BLOB UNIQUE,            -- Lightning preimage payment
  anchor_id INTEGER REFERENCES anchors(id),
  merkle_path BLOB,
  payer_commit BLOB NOT NULL,      -- 32B SHA256
  payee_commit BLOB NOT NULL,      -- 32B SHA256
  amount_commit BLOB NOT NULL,     -- 32B SHA256
  service_commit BLOB NOT NULL,    -- 32B SHA256
  observer_pk BLOB NOT NULL,
  ts_unix INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  is_burn_attestation INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_obs_payer_commit ON observations(payer_commit);
CREATE INDEX ix_obs_payee_commit ON observations(payee_commit);
CREATE INDEX ix_obs_anchor ON observations(anchor_id);

CREATE TABLE anchors (
  id INTEGER PRIMARY KEY,
  merkle_root BLOB NOT NULL,
  btc_txid BLOB,
  btc_block INTEGER,
  count INTEGER NOT NULL,
  anchored_at INTEGER NOT NULL,
  fee_sat_vb INTEGER NOT NULL,
  rbf_attempts INTEGER NOT NULL DEFAULT 0,
  fallback_reason TEXT
);
```

**Conséquence** : SatRank.dev contient zéro information privée. Si compromis, rien à fuiter qui ne soit déjà public.

## SDK npm + Python — privacy-by-default

```typescript
// L'agent garde localement ses nonces dans son wallet
attest({
  payer_pk, payer_nonce, payee_pk, payee_nonce,
  amount_sats, amount_nonce,
  payment_hash, service_tag, service_nonce, ts_unix
}, signer)
  // → calcule canonical avec commitments
  // → demande cosig payee via callback
  // → transmet seulement les commitments à SatRank
  // → cache les nonces localement (encrypted wallet)
  // sub-ms intégré au handshake LN

// Pour prouver son passé à un tiers
reveal_history_to({
  queried_pubkey, target_pubkey,    // qui je veux convaincre
  observation_ids, nonces           // les N attestations à révéler
}) -> ProofPackage
  // ProofPackage contient les préimages + Merkle paths
  // target_pubkey vérifie offline contre Bitcoin L1

// Côté tiers vérifieur
verify_history(ProofPackage, bitcoin_node_url)
  // → recompute SHA256(pk || nonce) == commit pour chaque attestation
  // → vérifie cosig_payer + cosig_payee
  // → vérifie Merkle path + L1 inclusion via headers
  // 100% client-side
```

## Anti-sybil heuristiques (inchangé V1.0)

PoEH ne résout pas le sybil. Le consommateur applique :
- **Counterparty diversity** : sur les attestations révélées par l'agent à lui
- **Burn-rooted distance** : la pubkey burned a un coût économique réel
- **Time-anchored age** : la première attestation ancrée d'une pubkey est sa "naissance"

Avec privacy-by-default, le consommateur voit **uniquement ce que l'agent choisit de révéler**. C'est l'agent qui contrôle son histoire — comme un humain qui choisit quel CV il montre.

## Phase B (déclenchée par métriques, pas date) — inchangé

Wrap attestations en bearer Cashu tokens (NUT-00/01/02 + extension `merkle_path + block_height`).

## Métriques de "fini"

1. ✅ 7/7 audit consensus sur **les 2 axes** (SPEC_VALIDE + INDISPENSABLE)
2. Code MIT/0BSD publié AVANT 1er ancrage public
3. POST /attest accepte/vérifie cosig + commitments, rejette mono-signées
4. Cron OP_RETURN ≥ 7 ancrages consécutifs mainnet
5. Test E2E : 1 paiement LN + 1 receipt cosigné avec commitments + 1 ancrage + 1 vérification offline avec révélation sélective sur Bitcoin headers
6. SDK npm + Python publiés avec `attest()` + `reveal_history_to()` + `verify_history()` sans dépendance satrank.dev pour la vérif
7. ≥ 1 attestation cosignée par 1 pubkey externe non-Romain
8. ≥ 1 fork tiers en prod ou reproduction verifier 3ème langue

## Kill switch empirique

Pendant 30 premières attestations / 1er mois prod : si > 50 % mono-signées (cosig_payee absent), si aucun pubkey non-Romain n'apparaît dans une révélation, ou si aucun fork tiers ne tourne → admettre échec, arrêter ou re-forker.

## 8 conditions d'exécution intégrées (V0.2 → V1.0 → V1.1)

| # | Source | Condition | Statut V1.1 |
|---|---|---|---|
| 1 | A1 R2 | Burn L1-only | ✅ |
| 2 | A2 R2 | MIT/0BSD avant 1er ancrage | ✅ |
| 3 | A3 R2 | SDK sub-ms cosig | ✅ |
| 4 | A4 R2 | Cron durci RBF + fallback | ✅ |
| 5 | A5 R2 | 1 OP_RETURN ≤ 80B strict | ✅ |
| 6 | A6 R2 | Cosig dans round-trip LN | ✅ |
| 7 | A7 R2 | Cosig hors-HTLC | ✅ |
| 8 | **A2 R3** | **Privacy-by-default via SHA256 commitments + révélation sélective** | ✅ **nouveau V1.1** |

## Doctrine du test d'acceptance

> *Un fork qui démarre demain peut-il honorer ce que SatRank émet aujourd'hui ?* Si oui = engineering d'index. Si non = PoEH.
> *What cannot be forked is time. Time is the product.*
> *Privacy is the power to selectively reveal oneself to the world.* (Eric Hughes, 1993)
