# SatRank PoEH — spec V0.1 (à valider)

**Nom interne** : Proof-of-Economic-History (PoEH).
**Public-facing** : nom à décider après validation, mais *pas* "trust oracle", *pas* "trust ranking", *pas* "notarisation Bitcoin".

## Mission

Fournir une primitive cryptographique permettant à un agent Bitcoin souverain de **prouver son passé économique** à un inconnu, sans permission, sans intermédiaire de confiance, sans tribunal humain. Vérifiable offline contre Bitcoin L1 par n'importe qui.

## Doctrine immuable (rejet définitif)

- ✗ x402, USDC, EVM, stablecoin non-Bitcoin
- ✗ Soumission BIP / standardisation cross-écosystème
- ✗ Compliance, KYC, AML, EU AI Act, SOC2
- ✗ Partenariats avec Lightning Labs / Anthropic / Coinbase
- ✗ Tribunal humain ou comité d'oracle (pas de Schnorr threshold dispute)
- ✗ Cohabitation V1/V2 — remplacement direct
- ✗ Hardware capex (compute markets, storage)
- ✓ Solo dev (Romain + Claude Code)
- ✓ Bitcoin-pur strict (Lightning + L1 OP_RETURN + Schnorr/Ed25519)

## Spec produit (3 endpoints, 2 tables, 1 cron)

### POST /attest — 10 sats Lightning

**Input** (JSON, signé) :
```
{
  payer_pubkey,       // 32B x-only secp256k1
  payee_pubkey,       // 32B x-only secp256k1
  amount_sats,        // u64
  payment_hash,       // 32B (Lightning HTLC hash)
  service_tag,        // string ≤ 64 bytes (catégorie ouverte : "data/finance", "compute/gpu", "info/news", etc.)
  ts_unix,            // i64
  cosig_payer,        // 64B Schnorr BIP-340 sur sha256(canonical(payload))
  cosig_payee,        // 64B Schnorr BIP-340 sur sha256(canonical(payload)) — OBLIGATOIRE
  observer_pubkey,    // 32B (qui submit ; en V2 = SatRank seul)
  observer_sig        // 64B Schnorr
}
```

**Règle absolue** : `cosig_payee` doit être présent et valide. Sans elle, l'attestation est **rejetée HTTP 400**. Pas de downgrade. C'est l'invariant qui distingue PoEH d'un simple OpenTimestamps.

**Output** :
```
{
  observation_id,     // sha256(canonical(input))
  invoice,            // BOLT11, 10 sats
  expires_at,         // unix
  next_anchor_at      // unix (prochain ancrage L1 quotidien)
}
```

### GET /proof/:observation_id — gratuit

```
{
  observation_id,
  anchor: { merkle_root, btc_txid, block_height, block_hash },
  merkle_path,        // RFC 6962 binary tree
  leaf                // canonical(input)
}
```

Vérifiable 100 % client-side contre n'importe quel nœud Bitcoin SPV.

### GET /endpoint/:pubkey?since=:block — gratuit

Retourne les observations ancrées impliquant cette pubkey (en `payer` OU `payee`). Pagination par block height.

### Cron quotidien (heure UTC fixe, choisie après mainnet)

1. Sélectionner `observations WHERE preimage IS NOT NULL AND anchor_id IS NULL`
2. SHA256d Merkle tree (RFC 6962)
3. PSBT avec OP_RETURN `<magic 4B> <root 32B>`, sortie change wallet hot
4. Broadcast, persist `btc_txid`, update `merkle_path` + `anchor_id` par observation

Magic bytes : `0x53524b32` (« SRK2 ») ou similaire — décidable post-validation.

## Tables DB (2 seulement)

```sql
CREATE TABLE observations (
  id BLOB PRIMARY KEY,         -- 32B sha256(canonical_input)
  payload BLOB NOT NULL,       -- canonical(input) intégral
  preimage BLOB UNIQUE,        -- 32B, NULL avant payment LN
  anchor_id INTEGER REFERENCES anchors(id),
  merkle_path BLOB,            -- concat hashes 32B
  payer_pk BLOB NOT NULL,
  payee_pk BLOB NOT NULL,
  service_tag TEXT NOT NULL,
  ts_unix INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL
);
CREATE INDEX ix_obs_payer ON observations(payer_pk, ts_unix);
CREATE INDEX ix_obs_payee ON observations(payee_pk, ts_unix);

CREATE TABLE anchors (
  id INTEGER PRIMARY KEY,
  merkle_root BLOB NOT NULL,
  btc_txid BLOB,               -- NULL avant broadcast
  btc_block INTEGER,           -- NULL avant confirmation
  count INTEGER NOT NULL,
  anchored_at INTEGER NOT NULL
);
```

## Architecture Phase B-ready (3 décisions non-négociables dès J1)

**1. Receipt extensible vers Cashu NUT-00** : le champ `payload` est un objet canonical-JSON dont la sérialisation est compatible avec le `secret` d'un proof Cashu. Phase B = wrapper sans refacto.

**2. Merkle tree RFC 6962** : pas de structure custom. Preuves d'inclusion 200-400 bytes. Compatible librairies Bitcoin standard.

**3. `observer_pubkey` générique** : V2 = SatRank seul. V4 = FROST t-of-n multi-observer (sans recoder). Le champ existe dès J1 dans le schéma.

## Phase A → Phase B

**Phase A** : ce qui est décrit ci-dessus. Notarisation cosignée mutuelle, ancrage L1 quotidien.

**Phase B** : chaque attestation Phase A devient un **bearer token Cashu blinded** (NUT-00/01/02) porté par l'agent. SatRank devient un mint Cashu standard avec extension `merkle_path + block_height` dans chaque proof. L'agent porte son passé en bearer asset transférable, vérifiable offline.

Phase B activée quand : ≥ 500 attestations cosignées / jour pendant 30 jours consécutifs avec ≥ 10 pubkeys non-Romain. Pas avant.

## Métriques de validation (pas de calendrier)

**Le système est "fini" quand TOUTES ces conditions sont vraies, en n'importe quel ordre** :

1. Spec validée 100 % par 7 agents Opus 4.7 indépendants (cet audit-ci)
2. Code en prod : POST /attest accepte, vérifie cosig_payer + cosig_payee, rejette les non-cosignées
3. Cron quotidien broadcast OP_RETURN avec succès, ≥ 7 ancrages consécutifs
4. Test E2E : 1 paiement Lightning + 1 receipt cosigné + 1 ancrage + 1 vérification offline contre Bitcoin headers, sans toucher SatRank
5. SDK minimal (npm + Python) qui expose `attest()` et `verify_proof()` sans dépendre de SatRank.dev pour la vérif
6. ≥ 1 attestation cosignée par 1 pubkey externe non-Romain (test d'adoption minimal)

**Kill switch empirique** :
- Pendant les 30 premiers jours après mise en prod : si > 50 % des attestations sont mono-signées (payee refuse de cosigner), la thèse cosignature mutuelle est morte → admettre L1 a raison → arrêter ou re-forker.

## Risque résiduel honnête

Le payee a un coût opérationnel à cosigner (générer une signature Schnorr, gérer sa clé). En 2026 ce coût est non-trivial pour un agent humain-supervisé. En 2030+ avec SDK natif, c'est invisible. **Le pari est que le SDK PoEH devient la convention du paid-Lightning-call entre agents Bitcoin avant que des concurrents standardisent autrement**.

## Ce qui ne change PAS depuis V1

- AEPS Merkle anchor cron déjà en prod — réutilisé tel quel
- Bitcoind systemd, LND wallet — base infra inchangée
- Distribution npm/Smithery/MCP registry — repackagée avec 3 outils au lieu de 16
- Schnorr/Ed25519 helper code — réutilisé

## Ce qui DOIT être supprimé (≈ 3400 LOC)

- `mini_llm_*` (3 outils + cache)
- `intent` + Bayesian state + p_e2e 5-stage + scoring tables
- ClaimEngine + operator_bonds + slashing 1×/2×/3×/5×
- Schnorr threshold dispute oracle
- aeps.list_forks + get_observations + get_multihop + get_dispute (debug only)
- DNS TXT operator attestation (remplacé par observer_pubkey générique)
- ~70 tables résiduelles
- 25+ endpoints HTTP non-canoniques
- 16 outils MCP → 3 (attest, proof, endpoint)

## Question à valider

**Cette spec V0.1 est-elle prête à être implémentée comme produit unique de SatRank, en remplacement complet de la V1, sans ajout, sans usine à gaz, en respectant la doctrine cypherpunk Bitcoin-pure ?**
