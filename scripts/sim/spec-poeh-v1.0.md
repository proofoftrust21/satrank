# SatRank PoEH — spec V1.0 (validée 7/7 par 7 agents Opus 4.7 indépendants)

**Audit de convergence** : Round 1 (5/7) → spec V0.1 → Round 2 (7/7) → spec V1.0 ci-dessous, intégrant les 7 conditions résiduelles d'exécution.

## Mission

Fournir une primitive cryptographique permettant à un agent Bitcoin souverain de **prouver son passé économique** à un inconnu, sans permission, sans intermédiaire de confiance unique, vérifiable offline contre Bitcoin L1 par n'importe qui.

## Doctrine immuable

✗ x402, USDC, EVM, stablecoin non-Bitcoin
✗ BIP submission / standardisation cross-écosystème
✗ Compliance, KYC, AML
✗ Partenariats Lightning Labs / Anthropic / Coinbase
✗ Tribunal humain ou comité d'oracle
✗ Cohabitation V1/V2 — remplacement direct
✓ Solo dev + Bitcoin-pur strict + open-source MIT/0BSD obligatoire dès J1

## Architecture — multi-opérateur forkable

Le code PoEH est **MIT/0BSD open-source publié AVANT le premier ancrage public** (condition A2 ajoutée v0.2 → v1.0). N'importe qui fait tourner son propre opérateur. SatRank.dev = un opérateur public parmi N possibles. `observer_pubkey` strictement libre — toute pubkey valide peut servir d'observer (y compris l'agent lui-même).

## 3 endpoints, 2 tables, 1 cron

### POST /attest — 10 sats Lightning

Input RFC 8785 JCS canonical-JSON :

```json
{
  "v": 1,
  "payer_pubkey":      "<32B hex x-only secp256k1>",
  "payee_pubkey":      "<32B hex x-only secp256k1>",
  "amount_sats":       <u64>,
  "payment_hash":      "<32B hex Lightning HTLC hash>",
  "service_tag":       "<≤64 bytes UTF-8 string>",
  "ts_unix":           <i64>,
  "cosig_payer":       "<64B hex Schnorr BIP-340>",
  "cosig_payee":       "<64B hex Schnorr BIP-340 — REQUIRED>",
  "observer_pubkey":   "<32B hex x-only secp256k1>",
  "observer_sig":      "<64B hex Schnorr BIP-340>"
}
```

**Règles invariantes** :

1. `cosig_payer` ET `cosig_payee` obligatoires, valides Schnorr sur `sha256(canonical_jcs(payload_sans_observer_sig))`. Sans cosig_payee → HTTP 400. Pas de downgrade.
2. `observer_pubkey` libre — peut être payer, payee, ou tiers.
3. Sérialisation déterministe byte-pour-byte (RFC 8785).
4. **Cosignature hors-HTLC** (condition A7) : la cosignature Schnorr est calculée côté client AVANT ou EN PARALLÈLE du paiement Lightning, jamais en modifiant les hops HTLC. Le SDK l'intègre au round-trip de paiement mais ne touche pas le protocole LN.

### Anti-sybil — proof-of-burn L1-only (condition A1 finalisée)

Pour qu'une pubkey soit `verified`, elle doit avoir effectué un burn préalable de ≥ 10 000 sats vers une **OP_RETURN Bitcoin L1** (non vers un mint Cashu — option Cashu retirée par A1 round 2). Cette preuve est elle-même une attestation PoEH avec `service_tag = "poeh:burn"`. Sans burn, attestations acceptées mais flaggées `unverified`.

### GET /proof/:observation_id — gratuit

Merkle inclusion path RFC 6962 + `btc_txid` + `block_height` + `block_hash`. Vérifiable 100 % client-side contre Bitcoin L1 sans satrank.dev.

### GET /endpoint/:pubkey?since=:block&include_unverified=<bool> — gratuit

Liste des observations ancrées impliquant cette pubkey.

### Cron d'ancrage (heure UTC fixe à choisir post-mainnet)

Durci selon condition A4 :

1. SELECT observations payées non-ancrées
2. SHA256d Merkle tree RFC 6962 sur `id`s triés lexicographiquement
3. PSBT avec **strictement 1 OP_RETURN ≤ 80 bytes** (condition A5) : `<MAGIC 0x53524b32> <merkle_root 32B>` = 36 bytes total
4. Fee strategy : estimate P75 mempool 6-blocks lookahead, RBF activé par défaut
5. **Fallback** : si mempool > 200 sat/vB pendant 6h, skip l'ancrage du jour, agréger lendemain. Documenté publiquement.
6. **Monitoring mempool** : alerte si fee > 100 sat/vB pendant 2h
7. Broadcast. Persist `btc_txid`. Update `merkle_path` + `anchor_id` après confirmation.

**Pas de dérive vers covenant ou taproot-script consensus-load** (condition A5). Strictement OP_RETURN classique.

## Tables DB

```sql
CREATE TABLE observations (
  id BLOB PRIMARY KEY,
  payload BLOB NOT NULL,
  preimage BLOB UNIQUE,
  anchor_id INTEGER REFERENCES anchors(id),
  merkle_path BLOB,
  payer_pk BLOB NOT NULL,
  payee_pk BLOB NOT NULL,
  observer_pk BLOB NOT NULL,
  service_tag TEXT NOT NULL,
  ts_unix INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  is_burn_attestation INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_obs_payer ON observations(payer_pk, ts_unix);
CREATE INDEX ix_obs_payee ON observations(payee_pk, ts_unix);

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

## SDK npm + Python — sub-ms cosignature (conditions A3 + A6)

```typescript
attest({ payer_pk, payee_pk, amount_sats, payment_hash, service_tag, ts_unix }, signer)
  // → calcule canonical_jcs, signe Schnorr côté local, demande cosig payee via callback
  //   intégré au round-trip de paiement Lightning existant
  //   AUCUN round-trip distinct ; cosignature sub-ms
verify_proof(observation_id, bitcoin_node_url)
  // → fetch /proof/:id, vérifie cosig_payer + cosig_payee + Merkle path + L1 inclusion
  //   100% client-side, ne dépend PAS de satrank.dev pour la vérif
  // → publié AVANT premier ancrage public (condition A2)
```

## Anti-sybil — heuristiques côté consommateur (documentées)

PoEH ne résout PAS le sybil par construction. Les consommateurs appliquent leurs heuristiques sur le graphe ancré :

- **Counterparty diversity** : `len(unique_counterparties) / len(all_counterparties)`
- **Burn-rooted distance** : pubkey "trustworthy" si ≥ N contre-parties ont burn ≥ 10 000 sats avec ancienneté ≥ T blocks
- **Time-anchored age** : la première attestation ancrée d'une pubkey = sa "naissance" non-falsifiable

Comme Bitcoin n'identifie pas qui est honnête — il expose la chain et chacun fait son analyse.

## Phase B (déclenchée par métriques, pas date)

Quand ≥ 500 attestations cosignées / jour pendant 30 jours consécutifs avec ≥ 10 pubkeys non-Romain : wrap chaque attestation en bearer Cashu token (NUT-00/01/02 + extension `merkle_path + block_height`). Pas avant.

## Métriques de "fini" (toutes vraies, en n'importe quel ordre)

1. ✅ Spec validée 7/7 par 7 agents indépendants Opus 4.7 (round 2 atteint)
2. Code MIT/0BSD publié sur GitHub **AVANT** premier ancrage public
3. POST /attest accepte/vérifie cosig_payer + cosig_payee, rejette mono-signées
4. Cron OP_RETURN ≥ 7 ancrages consécutifs sur mainnet
5. Test E2E : 1 paiement LN + 1 receipt cosigné + 1 ancrage + 1 vérification offline contre Bitcoin headers, sans satrank.dev
6. SDK npm + Python publié exposant `attest()` + `verify_proof()` sans dépendance satrank.dev
7. ≥ 1 attestation cosignée par 1 pubkey externe non-Romain
8. ≥ 1 fork du code source mis en prod par un opérateur tiers (ou ≥ 1 reproduction du verifier dans une 3ème langue)

## Kill switch empirique

Pendant les 30 premières attestations / le premier mois en prod : si > 50 % sont mono-signées (cosig_payee absent), si aucun pubkey non-Romain n'apparaît, ou si aucun fork tiers ne tourne → admettre que la friction cosignature est prohibitive → arrêter ou re-forker la doctrine.

## 7 conditions d'exécution (intégrées de v0.2 au v1.0)

| # | Agent | Condition | Statut |
|---|---|---|---|
| 1 | Devil's advocate | Retirer option burn Cashu, garder burn L1 only | ✅ intégré |
| 2 | Cypherpunk orthodoxe | Publier MIT/0BSD + verifier AVANT 1er ancrage public | ✅ métrique #2 |
| 3 | Économiste hayekien | SDK sub-ms cosignature ; kill switch 30j garantie résiduelle | ✅ intégré |
| 4 | Architecte solo dev | Cron durci : fee strategy + RBF + fallback + monitoring | ✅ intégré |
| 5 | Bitcoin maximaliste | 1 seul OP_RETURN ≤ 80B, pas de covenant/taproot-script | ✅ intégré |
| 6 | Agent 2030 POV | SDK cosig dans round-trip Lightning, pas distinct | ✅ intégré |
| 7 | Lightning operator | Cosignature hors-HTLC, invoice LN standard | ✅ intégré |

## Doctrine du test d'acceptance

> *Un fork qui démarre demain peut-il honorer ce que SatRank émet aujourd'hui ?*
> Si oui, c'est de l'engineering d'index. Si non, c'est PoEH.

> *What cannot be forked is time. Time is the product.*
