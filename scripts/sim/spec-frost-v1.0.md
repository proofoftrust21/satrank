# SatRank FROST — spec V1.0 (candidat produit phare)

**Pivot R9 → R10** : abandon Auctions (cron daily incompatible avec deadlines blocks). Test d'une primitive cryptographiquement non-triviale — **coordination FROST threshold signatures multi-agents**, où la complexité crypto rend le DIY dangereux.

## Ce qu'est le produit

FROST (Flexible Round-Optimized Schnorr Threshold signatures) permet à N agents de produire une **unique signature Schnorr Bitcoin-valide** que tout vérificateur accepte comme une signature standard, mais dont la production exige t-of-n agents. Use cases agentiques 2030 :

- **Multisig wallet entre N agents** : 4-of-7 partenaires d'un fonds autonome
- **Oracles décentralisés** : 3-of-5 oracles signent un fait (prix, événement)
- **DAO cypherpunk binding votes** : 51% de N membres signent un commit
- **Signing fédéré agent-to-agent** : N agents co-signent une transaction Bitcoin/Lightning
- **Co-spending threshold** : 5-of-9 agents libèrent un fond commun

FROST est un protocole **multi-round** (DKG → commitments → signatures partielles → aggregation), cryptographiquement délicat. Une implémentation incorrecte crée des **vulnérabilités catastrophiques** (key extraction, signature forgery). Solo dev DIY = risque inacceptable pour un fonds.

**SatRank FROST** = un coordinateur trusted-minimum qui orchestre les rounds FROST. SatRank ne voit JAMAIS les clés privées ni les nonces secrets — seulement les commitments publics. Son rôle est l'**ordering + aggregation publique**, pas la garde de secrets.

## Mission

Permettre à N agents IA Bitcoin-souverains distribués de **co-signer une transaction Bitcoin/Lightning** via FROST t-of-n, sans intermédiaire de confiance gardant des clés, sans permission, sans KYC, avec signature finale **indistinguable** d'une signature Schnorr classique pour Bitcoin.

## Doctrine immuable (inchangée)

✗ x402 / USDC / EVM / stablecoin non-Bitcoin
✗ BIP submission externe / standardisation cross-écosystème
✗ Compliance, KYC, AML
✗ Partenariats Lightning Labs / Anthropic / Coinbase
✗ Tribunal humain ou comité d'oracle
✓ Solo dev + Bitcoin-pur strict + open-source MIT/0BSD dès J1
✓ Privacy-by-default (commitments uniquement, pas de clés/nonces vus)

## Pourquoi indispensable (3 prémisses)

**P1 — FROST DIY est cryptographiquement dangereux.**
Le protocole exige : DKG (Distributed Key Generation) avec verifiable secret sharing, commitment-binding pour éviter rogue-key attacks, vérification stricte des partial signatures, ordering déterministe pour réplay-resistance. Une erreur dans n'importe lequel = perte de fonds. Solo dev qui code ça lui-même prend 6+ mois pour atteindre la sécurité de référence (frostd, nostr-tools/frost). **SatRank FROST = implémentation auditée open-source MIT** que tout agent peut utiliser comme service ou comme library. Le coût d'erreur est si élevé que les agents préfèrent une lib établie + un coordinateur public à une roll-your-own.

**P2 — La coordination N-parties asynchrones distribuées exige un point de rendez-vous.**
Sans coordinateur, N agents distribués (différents fuseaux, différents uptimes) ne peuvent pas synchroniser les rounds FROST en pratique. Nostr DMs marchent mais sont lents et fragiles. **SatRank FROST agit comme bus de message round-aware** : tous les agents postent leur contribution à SatRank, qui aggrège quand le quorum est atteint. C'est un service dont la valeur croît avec le nombre d'agents qui l'utilisent (effet de réseau réel des sessions concurrentes).

**P3 — Trustless coordinator** est cryptographiquement vérifiable.
SatRank ne stocke jamais de clé privée ni de nonce secret. Il ne voit que commitments publics, partial sigs publiques, aggregated sig publique. **Si SatRank est compromis, les fonds restent saufs** — la pire chose qu'un SatRank malicieux peut faire = censurer une session ou en initier une fausse, mais il ne peut pas voler. Cette propriété "trustless coordinator" est une garantie cryptographique du protocole FROST, pas une promesse SatRank.

## Spec produit (3 endpoints, 2 tables, 1 cron)

### POST /frost/session/init — 50 sats Lightning (par initiateur)

```json
{
  "session_id":      "<32B hex sha256(canonical(participants_pubkeys))>",
  "participants":    ["<32B hex pubkey>", ...],  // n participants
  "threshold":       <u8>,                       // t (≤ n)
  "message_to_sign": "<32B hex digest>",
  "session_metadata": "<canonical JSON>",        // contexte
  "initiator_pubkey": "<32B hex>",
  "initiator_sig":   "<64B Schnorr>"
}
```

L'initiateur paye 50 sats pour ouvrir la session (couvre l'orchestration multi-round + ancrage final).

### POST /frost/session/:id/commit — gratuit

Round 1 du FROST : chaque participant poste son nonce_commitment public.

```json
{
  "session_id":         "<32B hex>",
  "participant_pubkey": "<32B hex>",
  "nonce_commitment":   "<33B hex secp256k1 point>",  // R_i
  "participant_sig":    "<64B Schnorr sur (session_id || nonce_commitment)>"
}
```

SatRank vérifie la signature, stocke le commitment. Quand t-of-n commitments distincts reçus, SatRank publie l'**aggregated commitment** (sum des points) accessible à tous via GET /session/:id/state.

### POST /frost/session/:id/sign — gratuit

Round 2 : chaque participant soumet sa partial signature après avoir lu l'aggregated commitment.

```json
{
  "session_id":         "<32B hex>",
  "participant_pubkey": "<32B hex>",
  "partial_sig":        "<32B hex scalar>",       // s_i
  "participant_sig":    "<64B Schnorr>"
}
```

SatRank vérifie chaque partial sig contre la pubkey du participant et l'aggregated commitment. Quand t partial sigs valides : SatRank produit la signature finale aggregated `(R, s)` (32 + 32 bytes), publie le résultat, et ancre `(session_id, message_hash, final_signature)` dans le Merkle quotidien.

### GET /session/:id/state — gratuit

Retourne l'état actuel de la session : participants, commitments reçus, partial sigs reçues, final signature si quorum atteint, anchor block_height si ancré.

### Cron quotidien (00:05 UTC)

1. SELECT toutes les sessions complétées du jour
2. SHA256d Merkle tree RFC 6962 sur (session_id || message_hash || final_signature)
3. PSBT avec strict 1 OP_RETURN ≤ 80B = `<MAGIC 0x53524654> <merkle_root 32B>` (« SRFT » = SatRank FROST)
4. Fee strategy P75 + RBF + fallback (V1.0)
5. Broadcast Bitcoin L1
6. Persist + update merkle paths par session

L'ancrage L1 garantit que **la session de signature a eu lieu à la date prétendue** — utile pour l'audit ex-post de DAOs, fonds, oracles.

## Tables DB (2)

```sql
CREATE TABLE sessions (
  id BLOB PRIMARY KEY,             -- 32B session_id
  participants_json TEXT NOT NULL, -- liste pubkeys
  threshold INTEGER NOT NULL,
  message_hash BLOB NOT NULL,
  metadata_canonical TEXT NOT NULL,
  initiator_pk BLOB NOT NULL,
  initiator_sig BLOB NOT NULL,
  preimage_init BLOB UNIQUE,       -- 50 sats Lightning
  state TEXT NOT NULL,             -- 'open' | 'committed' | 'signing' | 'completed' | 'expired'
  aggregated_commitment BLOB,
  final_signature_r BLOB,
  final_signature_s BLOB,
  anchor_id INTEGER REFERENCES anchors(id),
  merkle_path BLOB,
  initiated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE session_contributions (
  id INTEGER PRIMARY KEY,
  session_id BLOB NOT NULL REFERENCES sessions(id),
  participant_pk BLOB NOT NULL,
  round INTEGER NOT NULL,           -- 1=commit, 2=partial_sig
  payload BLOB NOT NULL,
  participant_sig BLOB NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX ix_contrib_session ON session_contributions(session_id, round);
```

## SDK npm + Python — FROST native

```typescript
import { FROST } from '@satrank/frost';

frost.create_session(participants, threshold, message_to_sign, initiator_signer)
  -> session_id

frost.commit(session_id, participant_signer)
  -> nonce_commitment posted, awaits quorum

frost.sign(session_id, participant_signer)
  -> partial_sig posted, awaits final aggregation

frost.get_final_signature(session_id) -> SchnorrSig
  // → 64B Schnorr signature standard, broadcastable Bitcoin

verify_session_anchor(session_id, bitcoin_node_url)
  // → vérifie Merkle inclusion L1 + final sig + headers
  // → 100% offline post-anchoring
```

L'agent n'a pas besoin d'implémenter FROST lui-même — le SDK le fait. Le SDK est open-source, auditable, MIT.

## Économie

- **50 sats / session_init** = ~$0.03 à $60k/BTC
- Volume estimé 2030 :
  - 1M agents × 1 session/semaine (multisigs, oracles, votes) = 140k sessions/jour × 50 sats = 7M sats/jour
  - DAOs cypherpunk × 100 votes/jour × 1000 DAOs = 100k sessions/jour × 50 sats = 5M sats/jour
  - Total bear : ~12M sats/jour ≈ $7k/jour
  - Bull : 50M sessions/jour ≈ $30k/jour
- Marge SatRank : ~95% (compute négligeable, OP_RETURN amorti)

## Privacy

SatRank ne voit jamais :
- Les clés privées des participants
- Les nonces secrets (juste les commitments publics)
- Le contexte sémantique du message si l'initiateur fournit `metadata_canonical = ""` (vide)

Privacy-by-default : un agent peut faire FROST anonyme via stealth pubkeys.

## Anti-fraud

SatRank peut censurer une session (ne pas la traiter) — c'est détectable car le state est public via GET /session/:id/state. Les participants peuvent fork-deploy le coordinateur sur une autre instance (open-source MIT).

SatRank ne peut **pas** voler les fonds — c'est mathématiquement impossible avec FROST si l'implémentation est correcte. C'est la garantie cryptographique.

## Métriques de "fini"

1. ✅ 7/7 audit consensus sur SPEC_VALIDE + INDISPENSABLE
2. Code MIT/0BSD publié AVANT 1er ancrage, audité externalement (1 audit pro coût ~5-10k sats sur Cody Audits ou similaire crypto)
3. POST /frost/session/init + commit + sign fonctionnels
4. Cron OP_RETURN ≥ 7 ancrages consécutifs avec sessions complétées
5. Test E2E : 1 session 3-of-5 entre 5 nodes distincts + 1 final signature broadcastable Bitcoin + 1 vérification Schnorr standard
6. SDK npm + Python publiés
7. ≥ 1 session initiée par 1 pubkey externe non-Romain
8. ≥ 1 fork tiers en prod ou reproduction du verifier dans 3ème langue

## Kill switch empirique

Pendant 30 premiers jours en prod : si < 5 sessions/jour, < 50% taux de complétion (sessions qui n'atteignent pas le quorum), aucun pubkey externe → admettre que le marché ne valide pas la primitive coordination FROST → arrêter.

## Doctrine du test d'acceptance

> *Un fork qui démarre demain peut-il honorer les sessions FROST SatRank d'avril 2026 ?* Non — il n'a pas (a) les commitments historiques, (b) l'ancrage L1 du final_signature, (c) le timestamp prouvé.
> *FROST est trop dangereux à roll-your-own pour solo dev — l'audit + la production-grade implementation sont l'indispensabilité.*

## Question round 10

Cette spec **SatRank FROST V1.0** rend-elle SatRank techniquement saine (SPEC_VALIDE) **ET** indispensable pour un agent IA Bitcoin-souverain 2030 qui veut co-signer avec d'autres agents (multisig, oracle, DAO, signing fédéré) sans rouler son propre FROST (INDISPENSABLE) ?
