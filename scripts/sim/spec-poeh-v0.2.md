# SatRank PoEH — spec V0.2

**Changements vs v0.1** :
- Réponse au blocker A1 (sybil) : `proof-of-burn` minimum pour qu'une pubkey soit "verified", couplée à une heuristique de **diversité des contre-parties** explicite côté consommateur. SatRank n'élimine pas le sybil — SatRank fournit la matière première du graphe sur laquelle l'analyse anti-sybil s'applique. Comme Bitcoin ne dit pas qui est honnête.
- Réponse au blocker A2 (trusted intermediary) : `observer_pubkey` strictement libre dès J1. Le code est open-source. N'importe qui fait tourner son propre opérateur PoEH. SatRank.dev = juste UN opérateur public, pas l'autorité. Plusieurs anchors par jour OK ; le client choisit ses observateurs.
- Conditions techniques intégrées : canonical-JSON déterministe byte-pour-byte (RFC 8785 JCS), fee strategy OP_RETURN avec RBF + fallback mempool, magic bytes 4B publics, SDK cosignature zéro-friction sub-ms intégré handshake LN, invoice timeout < 60s.

## Mission

Fournir une primitive cryptographique permettant à un agent Bitcoin souverain de **prouver son passé économique** à un inconnu, sans permission, sans intermédiaire de confiance unique, vérifiable offline contre Bitcoin L1 par n'importe qui.

## Doctrine immuable

✗ x402, USDC, EVM, stablecoin non-Bitcoin
✗ BIP submission / standardisation
✗ Compliance, KYC, AML
✗ Partenariats Lightning Labs / Anthropic / Coinbase
✗ Tribunal humain ou comité d'oracle
✗ Cohabitation V1/V2
✓ Solo dev + Bitcoin-pur strict + open-source obligatoire

## Architecture forkable et multi-opérateur (changement majeur vs v0.1)

**Le code PoEH est MIT/0BSD open-source dès J1.** N'importe qui peut faire tourner son propre opérateur :
- Un agent peut être son propre observer
- Une organisation peut faire tourner son PoEH-node interne
- Plusieurs PoEH-nodes co-existent ; ils ancrent leurs Merkle roots dans des OP_RETURN distincts
- Les agents choisissent leur(s) observer(s) selon préférence (latence, juridiction, réputation de l'observer)

**Conséquence** : `observer_pubkey` n'est PAS privilégié. Le champ est libre — toute pubkey valide peut servir d'observer. SatRank.dev expose un opérateur public à 10 sats/attestation, mais c'est juste un service parmi d'autres.

## Spec produit (3 endpoints, 2 tables, 1 cron)

### POST /attest — 10 sats Lightning (sur l'opérateur public satrank.dev)

**Input** (RFC 8785 JCS canonical-JSON) :

```json
{
  "v": 1,
  "payer_pubkey":      "<32B hex x-only secp256k1>",
  "payee_pubkey":      "<32B hex x-only secp256k1>",
  "amount_sats":       <u64>,
  "payment_hash":      "<32B hex Lightning HTLC hash>",
  "service_tag":       "<≤64 bytes UTF-8 string, free-form>",
  "ts_unix":           <i64>,
  "cosig_payer":       "<64B hex Schnorr BIP-340>",
  "cosig_payee":       "<64B hex Schnorr BIP-340>",
  "observer_pubkey":   "<32B hex x-only secp256k1>",
  "observer_sig":      "<64B hex Schnorr BIP-340>"
}
```

**Règle invariante** :

1. `cosig_payer` ET `cosig_payee` DOIVENT être présents et valides Schnorr sur `sha256(canonical_jcs(payload_sans_observer_sig))`. Sans cosig_payee → HTTP 400. Pas de downgrade.
2. `observer_pubkey` peut être n'importe quelle pubkey valide — incluant `payer_pubkey` ou `payee_pubkey` ou un tiers. Le rôle observer = quiconque accepte la responsabilité de submit.
3. La sérialisation est déterministe byte-pour-byte (RFC 8785) : toute ambiguïté casse la vérif offline + le futur wrap Cashu.

**Anti-sybil — proof-of-burn pubkey eligibility** :

Pour qu'une pubkey soit considérée "verified" dans les requêtes de réputation, elle doit avoir effectué un **burn Lightning** initial : payer une invoice à un mint Cashu (ou directement burn vers `OP_RETURN` Bitcoin) d'au moins 10 000 sats, ancré dans un block Bitcoin antérieur à sa première attestation. Cette preuve de burn est elle-même une attestation PoEH (`service_tag = "poeh:burn"`, `payee_pubkey` = pubkey à activer, `payer_pubkey` = même pubkey ou tiers).

Pubkeys non-burned : attestations acceptées mais flaggées `unverified`. Les consommateurs choisissent leur seuil.

**Output** :

```json
{
  "observation_id":     "<32B hex sha256(canonical_jcs(input))>",
  "invoice":            "<BOLT11, 10 sats, expiry < 60s>",
  "expires_at":         <unix>,
  "next_anchor_at":     <unix>
}
```

### GET /proof/:observation_id — gratuit

Retourne `{ observation_id, anchor: { merkle_root, btc_txid, block_height, block_hash }, merkle_path: [...], leaf: <canonical_jcs(input)> }`. Vérifiable offline contre Bitcoin L1 sans interroger SatRank.

### GET /endpoint/:pubkey?since=:block&include_unverified=<bool> — gratuit

Retourne les observations ancrées impliquant cette pubkey en `payer` OU `payee`. Filtre `include_unverified` (défaut: false) selon proof-of-burn.

### Cron d'ancrage (heure UTC fixe à choisir post-validation)

1. Sélectionner toutes les `observations WHERE preimage IS NOT NULL AND anchor_id IS NULL` (les payées non-encore ancrées)
2. SHA256d Merkle tree RFC 6962 sur `id`s triés lexicographiquement
3. Construire PSBT avec **1 seul** OP_RETURN `<MAGIC 4B> <merkle_root 32B>` (≤ 80 bytes, standardness respectée)
4. Estimer fee conservateur (P75 mempool 6-blocks lookahead). RBF activé par défaut.
5. **Fallback** : si mempool > 200 sat/vB pendant 6h, skip l'ancrage du jour, agréger avec lendemain. Documenté publiquement.
6. Broadcast. Persist `btc_txid`. Update `merkle_path` + `anchor_id` par observation après confirmation.

**Magic bytes** : `0x53524b32` (« SRK2 ») — public, documenté, reconnaissable par filtrage OP_RETURN.

## Tables DB (2 seulement)

```sql
CREATE TABLE observations (
  id BLOB PRIMARY KEY,         -- 32B sha256(canonical_jcs(input))
  payload BLOB NOT NULL,       -- canonical_jcs(input) intégral
  preimage BLOB UNIQUE,        -- 32B, NULL avant payment LN
  anchor_id INTEGER REFERENCES anchors(id),
  merkle_path BLOB,
  payer_pk BLOB NOT NULL,
  payee_pk BLOB NOT NULL,
  observer_pk BLOB NOT NULL,
  service_tag TEXT NOT NULL,
  ts_unix INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  is_burn_attestation INTEGER NOT NULL DEFAULT 0  -- 1 si service_tag='poeh:burn'
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
  rbf_attempts INTEGER NOT NULL DEFAULT 0
);
```

## SDK (npm + Python) — zero-friction cosignature

Le SDK expose :

```typescript
attest({ payer_pk, payee_pk, amount_sats, payment_hash, service_tag, ts_unix }, agent_signer)
  // → calcule canonical_jcs, demande signature Schnorr, attend cosig payee via callback
  //   (intégré au handshake LN — sub-ms quand les deux parties signent leur preimage HTLC)
verify_proof(observation_id, bitcoin_node_url)
  // → fetch /proof/:id, vérifie cosig_payer + cosig_payee + Merkle path + L1 inclusion
  //   100% client-side, ne dépend PAS de satrank.dev pour la vérif
```

Le SDK est l'élément qui rend la cosignature payee invisible : quand l'agent paye un HTLC Lightning, la cosignature PoEH est demandée dans le même round-trip. Coût opérationnel : sub-milliseconde.

## Anti-sybil par diversité (heuristique consommateur)

PoEH ne résout PAS le sybil par construction. PoEH fournit la **matière première du graphe** — les consommateurs appliquent leur propre heuristique. Exemples documentés dans la spec :

- **Counterparty diversity** : score = `len(unique_counterparties) / len(all_counterparties)`. Sybil farm aura ratio bas.
- **Burn-rooted distance** : pubkey est "trustworthy" si ≥ N de ses contre-parties ont burn ≥ M sats avec ancienneté ≥ T blocks.
- **Time-anchored age** : la première attestation ancrée d'une pubkey est sa "naissance" — non-falsifiable rétroactivement.

C'est l'analogue Bitcoin — la chain ne dit pas qui est honnête, mais expose une structure où l'analyse est possible.

## Phase B (mois ≈ M+? après volume cible atteint, pas date)

Quand ≥ 500 attestations cosignées / jour pendant 30 jours consécutifs avec ≥ 10 pubkeys non-Romain : activer Phase B = wrap chaque attestation en **bearer Cashu token** (NUT-00/01/02 + extension `merkle_path + block_height`). Pas avant.

## Métriques de validation (pas de calendrier humain)

Le système est "fini" quand TOUTES ces conditions sont vraies :

1. ✅ Spec validée 7/7 par 7 agents indépendants
2. Code en prod, MIT-licensed, fork tournable indépendamment
3. POST /attest accepte/vérifie cosig_payer + cosig_payee, rejette mono-signées
4. Cron OP_RETURN ≥ 7 ancrages consécutifs avec RBF documenté
5. Test E2E : 1 paiement LN + 1 receipt cosigné + 1 ancrage + 1 vérification offline (Bitcoin headers seuls), sans toucher satrank.dev
6. SDK npm + Python publiés, exposant `attest()` + `verify_proof()` sans dépendance satrank.dev
7. ≥ 1 attestation cosignée par 1 pubkey externe non-Romain dans `payer` ou `payee`
8. ≥ 1 fork du code source mis en prod par un opérateur tiers (ou ≥ 1 reproduction du verifier dans une 3ème langue)

## Kill switch empirique

Pendant les 30 premières attestations / le premier mois en prod : si > 50 % sont mono-signées (cosig_payee absent), si aucun pubkey non-Romain n'apparaît, ou si aucun fork tiers ne tourne → admettre L1 a raison sur la friction cosignature → arrêter ou re-forker la doctrine.

## Risque résiduel honnête

Cosignature payee a un coût opérationnel non-nul. Le pari est que le SDK rend ce coût asymptotiquement nul (sub-ms intégré au handshake LN) **avant** que les concurrents standardisent un format différent. Si le coût reste perçu en 2027-2028, le kill switch se déclenche.

## Question à valider — round 2

**Cette spec V0.2 répond-elle aux 2 blockers de v0.1 (sybil + trusted intermediary) sans réintroduire d'usine à gaz, en respectant la doctrine cypherpunk Bitcoin-pure et la contrainte solo dev ?**
