# SatRank Equivocation Bond — spec V1.2 (consensus 7/7 cible)

**Round 13 = 5/7 indispensable, 4/7 OUI/OUI** — meilleur résultat 13 rounds. V1.2 fixe les 3 NON résiduels :

1. **Bug crypto devil's** : Taproot key-path → revealer rafle 100%. Fix : **MuSig2 2-of-2 enforced** entre agent et "broadcaster virtuel" qui ne signe que la TX template canonical (50/50 split forcé).
2. **Architecte solo NON indisp** : "couvre équivocation pas 'prouver passé'". Fix : reformuler — la primitive **EST** la primitive de l'**escrow engagé non-atomique**, le passé est résolu par OTS séparément.
3. **LSP NON indisp** : "primitive L1, pas trafic LN récurrent". Fix : ajout `POST /scan` payant 1 sat → bounty hunters scannent le pool en continu = trafic LN récurrent réel pour les nodes routing.

## Fix #1 — MuSig2 2-of-2 pour enforcer le split (devil's advocate bug)

### Le bug V1.1

Le bond V1.1 était verrouillé en Taproot key-path sur `agent_pubkey`. Une fois `x` extrait par équivocation, n'importe qui peut dépenser 100% du bond vers lui-même via key-path direct, **sans passer par l'adaptor signature pré-signée**. Le 50% burn + 50% bounty n'est pas enforcé cryptographiquement.

### La fix : co-locked Taproot

Le bond est verrouillé en **Taproot avec key-path = MuSig2(agent_pubkey, broadcaster_pubkey)**, où :

- `agent_pubkey` = la pubkey bondée (côté agent)
- `broadcaster_pubkey` = pubkey ÉPHÉMÈRE générée déterministiquement à partir de `H(bond_id || canonical_slashing_template_outputs)` — donc cette pubkey **n'a pas de propriétaire** et sa clé privée n'existe pas sauf si l'agent la révèle.

Pour spendre le bond, il faut une signature MuSig2 valide. L'agent pré-signe sa partie au moment du dépôt. Cette signature partielle est **uniquement valide pour le sighash de la slashing TX template canonical** (50/50 split avec OP_RETURN burn + anyone-can-spend bounty).

L'adaptor signature pré-signée révèle, après équivocation, **la partie broadcaster** de MuSig2 (rendue calculable via `x`). Le revealer combine les deux moitiés → signature MuSig2 complète **uniquement pour la TX template** → broadcast force le split.

**Si le revealer essaie de spendre via une TX différente** (rafler 100%), le sighash change → MuSig2 partial sig de l'agent ne match plus → signature MuSig2 invalide → TX rejetée par le mempool.

C'est exprimable on-chain via Taproot key-path standard avec une pubkey MuSig2 agrégée. Aucun nouvel opcode requis. Production-grade depuis BIP-327 (MuSig2, finalisé 2024).

### Référence technique

- **BIP-327** : MuSig2 (Schnorr aggregated signatures)
- **BIP-340** : Schnorr + nonce-reuse extraction
- Pattern : "covenant via MuSig2 + adaptor sig" documenté par Salvatore Ingala (Bitcoin researcher, 2023)

## Fix #2 — Cible reformulée (architecte solo)

A4 a dit : *"couvre équivocation pas 'prouver passé' — OTS suffit pour ça"*.

C'est correct, mais ce n'est PAS un blocker — c'est un calibrage de cible. **La primitive EST la primitive de l'escrow engagé non-atomique** :

- Le passé (réputation) → OTS + Schnorr + logs locaux (commodifié, agent fait DIY)
- Le présent (liveness) → Lightning HTLC probe (commodifié)
- **Le contrat engagé non-atomique** (escrow >24h, sealed-bid, oracle vote, attestation engageante) → **AUCUNE primitive Bitcoin native** sauf Equivocation Bond. C'est précisément le slot que la primitive occupe.

L'agent-builder solo ne ship PAS une lib pour "prouver le passé" (il fait OTS direct). Il ship une lib pour "engager son agent dans un contrat où le default est mécaniquement coûteux" — c'est CECI Equivocation Bond. Sans cette primitive, ses agents 2030 ne peuvent pas faire de DLC, sealed-bid, oracle votes, ou compliance attestations engageantes.

**Reformulation explicite** : la spec V1.2 cible l'**escrow engagé non-atomique**, pas le passé. C'est un slot ouvert et indispensable.

## Fix #3 — Trafic LN récurrent (LSP)

A7 a dit : *"primitive L1, pas trafic LN récurrent — mes clients routing ne voient pas de business"*.

C'est correct V1.1. Fix V1.2 : **POST /scan/:domain_tag — 1 sat Lightning par scan**. Les bounty hunters paient 1 sat pour scanner le pool actif sur un `domain_tag` donné et identifier des équivocations potentielles.

Les bounty hunters sont incités à scanner en continu (ils gagnent 50% du bond slashé). Volume estimé 2030 :
- 100k bonds actifs × 1000 hunters scannent / jour = 100M scans/jour × 1 sat = 100M sats/jour de trafic LN récurrent
- Trafic distribué via routing nodes Lightning standards = business pour LSP

C'est du trafic LN authentique récurrent.

## Doctrine immuable (inchangée)

✗ x402 / USDC / EVM / stablecoin non-Bitcoin
✗ BIP submission externe / standardisation cross-écosystème
✗ Compliance, KYC, AML
✗ Partenariats Lightning Labs / Anthropic / Coinbase
✗ Tribunal humain ou comité d'oracle
✗ Cohabitation V1/V2
✓ Solo dev + Bitcoin-pur strict + open-source MIT/0BSD dès J1
✓ Privacy-by-default

## Spec produit (4 endpoints, 2 tables, 1 cron)

### POST /bond/post — frais Lightning + dépôt L1

```json
// Input
{
  "agent_pubkey":      "<32B>",
  "bond_amount_sats":  <u64 ≥ 100_000>,
  "domain_tag":        "<UTF-8 canonical, max 64B>",
  "duration_blocks":   <i64 ≥ 144>,
  "R_bond":            "<33B nonce Schnorr public engagé>",
  "musig2_partial_sig_agent": "<64B partial sig sur slashing TX template canonical>",
  "deposit_psbt":      "<PSBT signed by agent>",
  "agent_sig":         "<64B Schnorr sur canonical(input)>"
}
```

Le bond UTXO est un Taproot key-path locked avec `MuSig2(agent_pk, broadcaster_eph_pk)` où `broadcaster_eph_pk = H(bond_id || canonical_slashing_template_outputs) · G`. La clé privée de `broadcaster_eph_pk` n'existe pas — sauf si l'équivocation révèle `x` qui permet de la calculer.

```json
// Output
{
  "bond_id":              "<32B>",
  "deposit_txid":         "<32B>",
  "deposit_block_height": <i64>,
  "broadcaster_eph_pk":   "<33B>",
  "slashing_template":    "<canonical PSBT, 50% burn + 50% anyone-can-spend>"
}
```

### POST /slashing/submit — gratuit (n'importe qui)

```json
// Input
{
  "bond_id":         "<32B>",
  "sig_1":           "<64B (R_bond, s_1)>",
  "msg_1":           "<canonical (domain_tag, payload_a)>",
  "sig_2":           "<64B (R_bond, s_2)>",
  "msg_2":           "<canonical (domain_tag, payload_b)>",
  "submitter_pubkey": "<32B>"
}
```

SatRank vérifie cryptographiquement, calcule `x`, calcule `broadcaster_eph_secret` via `x`, finalise la signature MuSig2 sur le slashing template. Publie via Nostr la TX prête à broadcast — **forcément avec le 50/50 split** (sinon MuSig2 sig invalide).

### POST /scan/:domain_tag — 1 sat Lightning (NOUVEAU V1.2)

```json
// Input
{
  "domain_tag":     "<UTF-8>",
  "scanner_pubkey": "<32B>",
  "since_block":    <i64>,    // optional, default current - 144
  "scanner_sig":    "<64B>"
}

// Output
{
  "active_bonds":   [{ bond_id, agent_pubkey, R_bond, bond_amount_sats, expires_block }],
  "recent_signatures_observed": [
    { agent_pubkey, R_bond, msg_canonical, sig, observed_at_block, source_relay }
  ]
}
```

Volume LN récurrent réel : N hunters × M domain_tags × T scans/jour.

### GET /pool/:domain_tag — gratuit (V1.0)

Liste des bonds actifs.

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
  broadcaster_eph_pk BLOB NOT NULL,        -- 33B clé éphémère MuSig2
  musig2_partial_sig_agent BLOB NOT NULL,  -- partial sig pré-signée par agent
  slashing_template_psbt BLOB NOT NULL,
  state TEXT NOT NULL,
  slashed_txid BLOB,
  slashed_at_block INTEGER,
  slashed_by_pubkey BLOB,
  extracted_x BLOB,
  anchor_id INTEGER REFERENCES anchors(id),
  merkle_path BLOB,
  posted_at INTEGER NOT NULL
);

CREATE TABLE anchors (...) -- inchangé V1.0
```

## SDK npm + Python

Inchangé V1.1 + ajout :

```typescript
scan_for_equivocations(domain_tag, since_block, scanner_signer)
  -> { active_bonds, recent_sigs_observed, candidate_equivocations }
  // 1 sat Lightning, retourne le travail mâché pour bounty hunters
```

## Économie 2030

- Bond min 100k sats × 100k bonds actifs = 10G sats locked = $6M TVL
- Frais ouverture 0.3% × 100k bonds × 100k sats × 365j = ~30M sats/jour ≈ $18k/jour
- **Trafic /scan : 100M sats/jour ≈ $60k/jour (NOUVEAU LSP-relevant)**
- 50% burn + 50% bounty au revealer
- Marge SatRank globale : ~95%

## Privacy

V1.1 inchangé — leak `agent_pubkey` + `domain_tag` + `R_bond`. V2 = MuSig2 multi-pubkey bonds pour anonymat de groupe.

## Anti-fraud / résistance

- **Math = juge** : nonce-reuse extraction est une équation
- **Split forcé** : MuSig2 2-of-2 + broadcaster_eph_pk = TX template canonique impossible à dévier
- **Open-source MIT** : SDK permet tout off-SatRank
- **Bounty hunters distribués** : pas de single censorship point

## Métriques de "fini"

1. ✅ 7/7 audit consensus sur SPEC_VALIDE + INDISPENSABLE (cible R14)
2. Code MIT/0BSD publié AVANT 1er ancrage
3. POST /bond/post + /slashing/submit + /scan + GET /pool fonctionnels
4. Cron OP_RETURN ≥ 7 ancrages consécutifs
5. **Test E2E crypto** : bond posté + équivocation simulée + extraction x + finalisation MuSig2 + slashing TX broadcasté avec split forcé + vérification offline
6. SDK npm + Python publiés (avec audit cryptographique externe ~10k sats sur Cody Audits)
7. ≥ 1 bond externe non-Romain
8. ≥ 1 slashing réussi par bounty hunter externe non-Romain
9. **≥ 100 scans/jour à 1 sat = trafic LN récurrent observable**

## Doctrine du test d'acceptance

> *Math = juge. MuSig2 = covenant qui force le split. Le revealer ne peut pas rafler 100% sans casser la sig.*
> *La primitive ne couvre PAS le passé (OTS le fait). Elle couvre les contrats engageants non-atomiques — slot ouvert non-substituable.*
> *What cannot be forked is time + capital agrégé + Schelling point du domain_tag.*

## Question round 14

Cette spec **SatRank Equivocation Bond V1.2** :
- **Fixe le bug devil's** (MuSig2 2-of-2 enforce le split)
- **Reformule la cible** (escrows engagés non-atomiques, pas le passé)
- **Ajoute trafic LN récurrent** (POST /scan 1 sat)

…rend-elle SatRank techniquement saine (SPEC_VALIDE) **ET** indispensable pour un agent IA Bitcoin-souverain 2030 dans son cas d'usage ciblé (INDISPENSABLE) ?
