# SatRank Routing — spec V1.0 (candidat produit phare)

**Pivot complet** : abandon de la notarisation (PoEH), test d'un produit aux propriétés différentes — **routing intelligence Lightning Bitcoin-pure** pour agents.

## Ce qu'est le produit

Un agent IA Bitcoin-souverain qui fait 100-1000 paiements Lightning par jour a un problème opérationnel concret : **trouver une route Lightning fiable et bon marché entre lui et son destinataire**. Le graphe Lightning Network global compte ~70 000 nœuds et ~250 000 canaux en 2026, change toutes les minutes, et le pathfinding optimal n'est pas trivial : il faut considérer fees, liquidité, uptime, success-rate par canal.

Aujourd'hui, deux options :
1. **DIY** : maintenir localement un snapshot du graphe LN (~10-50 GB sync continu via gossip), faire pathfinding CPU-intensive, mettre à jour en continu, supporter le coût opérationnel
2. **API tierce** : Lightning Pool (Lightning Labs), Amboss, mempool.space — services centralisés avec API key, KYC, closed-source

**SatRank Routing** = la 3e option : routing intelligence Bitcoin-pure, sans permission, sans KYC, à 1 sat par lookup, signé Schnorr, score historique ancré Bitcoin L1.

## Mission

Permettre à un agent IA Bitcoin-souverain de **trouver une route Lightning optimale** sans maintenir lui-même le graphe LN, sans permission, en payant 1 sat par lookup, avec une **garantie cryptographique** offline-vérifiable que la route proposée a été calculée sur un snapshot graphe authentique.

## Doctrine immuable (inchangée)

✗ x402 / USDC / EVM / stablecoin non-Bitcoin
✗ BIP submission externe / standardisation cross-écosystème
✗ Compliance, KYC, AML
✗ Partenariats Lightning Labs / Anthropic / Coinbase
✗ Tribunal humain ou comité d'oracle
✓ Solo dev + Bitcoin-pur strict + open-source MIT/0BSD dès J1
✓ Privacy-by-default

## Pourquoi indispensable (3 prémisses)

**P1 — DIY est non-trivialement coûteux.**
Un agent léger (mobile, IoT, edge-deployed AI) ne peut **pas** maintenir 10-50 GB de graphe LN sync continu. Compute pathfinding non-trivial pour les routes complexes (multi-hop, MPP). Pour les agents lourds (datacenter), le DIY est techniquement faisable mais ROI négatif vs 1 sat/lookup à grande échelle.

**P2 — Les concurrents existants violent la doctrine.**
Lightning Pool, Amboss, mempool.space exigent **API keys + signup + KYC partiel**. Closed-source. Pas Bitcoin-pure. Un agent IA souverain qui doit déclarer son identité humaine pour utiliser une API LN viole le principe "sans permission" cypherpunk. **SatRank Routing est le seul service de routing LN sans permission.**

**P3 — La signature Schnorr + ancrage L1 ajoute une garantie inforgeable.**
Chaque route retournée est signée Schnorr avec une `route_id` qui inclut le hash du snapshot graphe LN utilisé. SatRank ancre quotidiennement sur Bitcoin L1 le hash du snapshot graphe + statistiques (nb routes calculées, nb succès observés). Un agent peut prouver à un tiers "j'ai utilisé une route SatRank du jour D, voici sa signature et l'ancrage L1" → audit de la performance ex-post.

## Spec produit (3 endpoints, 2 tables, 1 cron)

### POST /route — 1 sat Lightning

```json
// Input
{
  "from_pubkey": "<33B hex Lightning node pubkey>",
  "to_pubkey":   "<33B hex Lightning node pubkey>",
  "amount_sats": <u64>,
  "max_fee_sats": <u64>,
  "max_latency_ms": <u32>,
  "constraints": {
    "exclude_nodes": ["<pubkey>"],
    "prefer_low_uptime_score_min": <0-1.0>
  }
}

// Output (signé Schnorr par SatRank)
{
  "route_id":       "<32B hex sha256(canonical(graph_snapshot_hash || route_hops || ts_unix))>",
  "graph_snapshot_hash": "<32B hex>",
  "graph_snapshot_block_height": <i64>,
  "ts_unix":        <i64>,
  "route_hops": [
    { "node_pubkey", "channel_id", "fee_sats", "cltv_delta" }
  ],
  "estimated_success_prob": <0-1.0>,
  "estimated_total_fee_sats": <u64>,
  "estimated_latency_ms": <u32>,
  "alternate_routes_count": <u8>,
  "satrank_sig": "<64B Schnorr BIP-340>"
}
```

L'agent peut utiliser la route directement (BOLT11 multipath payment, send_to_route LND/CLN). Si la route échoue, l'agent peut reporter au cron `/route_failure` (gratuit).

### GET /graph_snapshot/:block_height — gratuit

Retourne le hash du snapshot graphe LN utilisé à un block donné, signé Schnorr SatRank, ancré L1. Permet de vérifier offline qu'une route_id donnée appartient bien à un snapshot authentique.

### GET /score/:from_pubkey?since=:block — gratuit

Retourne les statistiques historiques de routes SatRank impliquant ce nœud : nb routes proposées, nb succès observés, taux de succès, fees moyens. Tout est ancré L1 → audit ex-post inforgeable.

### Cron quotidien (00:05 UTC à choisir post-mainnet)

1. Calculer le hash du snapshot graphe LN actuel (`graph_snapshot_hash`)
2. Calculer les statistiques globales du jour : nb routes proposées, nb succès reportés, taux global, dispersion par catégorie
3. Construire un Merkle tree contenant tous les `route_id` du jour + les stats globales
4. PSBT avec strict 1 OP_RETURN ≤ 80B = `<MAGIC 0x53524d31> <merkle_root 32B>` (« SRM1 » = SatRank Routing Merkle)
5. Fee strategy P75 + RBF + fallback (V1.0)
6. Broadcast Bitcoin L1
7. Persist + update merkle paths

L'ancrage L1 garantit que **le score historique de SatRank Routing ne peut pas être réécrit**. Si dans 6 mois un agent dit "SatRank Routing m'a livré 99% de succès depuis avril", il peut le prouver contre Bitcoin L1.

## Tables DB (2)

```sql
CREATE TABLE routes_proposed (
  id BLOB PRIMARY KEY,         -- 32B route_id
  graph_snapshot_hash BLOB NOT NULL,
  block_height INTEGER NOT NULL,
  from_pk BLOB NOT NULL,       -- 33B
  to_pk BLOB NOT NULL,         -- 33B
  amount_sats BIGINT NOT NULL,
  hops_json TEXT NOT NULL,
  estimated_success_prob REAL NOT NULL,
  satrank_sig BLOB NOT NULL,
  preimage BLOB UNIQUE,        -- Lightning preimage (1 sat)
  anchor_id INTEGER REFERENCES anchors(id),
  merkle_path BLOB,
  proposed_at INTEGER NOT NULL,
  reported_outcome TEXT        -- NULL | 'success' | 'failure' | 'timeout'
);
CREATE INDEX ix_route_from ON routes_proposed(from_pk, proposed_at);
CREATE INDEX ix_route_anchor ON routes_proposed(anchor_id);

CREATE TABLE anchors (
  id INTEGER PRIMARY KEY,
  merkle_root BLOB NOT NULL,
  btc_txid BLOB,
  btc_block INTEGER,
  count INTEGER NOT NULL,
  anchored_at INTEGER NOT NULL,
  graph_snapshot_hash BLOB NOT NULL,
  total_routes_proposed INTEGER NOT NULL,
  total_routes_succeeded INTEGER NOT NULL,
  fee_sat_vb INTEGER NOT NULL,
  rbf_attempts INTEGER NOT NULL DEFAULT 0
);
```

## SDK npm + Python

```typescript
route(from_pk, to_pk, amount_sats, options) -> RouteResponse
  // → 1 sat Lightning, retourne route signée Schnorr
  // → cache local optionnel par graph_snapshot_hash
  
report_outcome(route_id, outcome: 'success' | 'failure' | 'timeout', error_code?)
  // → gratuit, feedback pour scoring futur
  // → améliore les heuristiques ML internes de pathfinding

verify_route_signature(route_response, satrank_pubkey) -> bool
  // → 100% client-side, pas de dépendance satrank.dev

verify_historical_score(score_response, bitcoin_node_url)
  // → fetch Merkle inclusion, recompute, vérifie L1
```

## Économie

- **1 sat / lookup** = ~$0.0006 à $60k/BTC. Pour un agent qui fait 1000 lookups/jour = 1000 sats/jour ≈ $0.60/jour
- DIY coût : 10-50 GB graphe + sync gossip continu + pathfinding CPU = $5-20/jour minimum côté infra cloud + dev time
- Économie nette pour l'agent : ~$5-19/jour vs DIY
- Volume estimé 2030 : 10M agents × 1000 lookups/jour × 1 sat = 10B sats/jour = ~$6M/jour
- Marge SatRank : ~95% (compute pathfinding négligeable une fois graphe en RAM, OP_RETURN amorti négligeable)

## Privacy

L'agent qui fait `/route` leak son `from_pubkey` à SatRank. Solution : le SDK supporte les **stealth keys** (BIP-352) — l'agent peut faire le lookup avec une pubkey stealth dérivée, jamais réutilisée. SatRank voit "X a demandé une route vers Y" mais ne peut pas corréler avec l'identité long-terme de l'agent.

## Anti-fraud

L'agent peut prouver une fraude SatRank en présentant : (a) la route_id signée par SatRank, (b) une démonstration que la route ne correspond pas au snapshot graphe authentique du block déclaré. SatRank perd alors crédibilité publiquement. Audit ex-post inforgeable.

## Métriques de "fini"

1. ✅ 7/7 audit consensus sur SPEC_VALIDE + INDISPENSABLE
2. Code MIT/0BSD publié AVANT 1er ancrage
3. POST /route fonctionnel, retourne route signée < 200ms p99
4. Cron OP_RETURN ≥ 7 ancrages consécutifs avec graph_snapshot_hash
5. Test E2E : 1 lookup + 1 paiement Lightning effectif via la route + 1 verify_route_signature offline
6. SDK npm + Python publiés
7. ≥ 1 lookup payé par 1 pubkey externe non-Romain
8. ≥ 1 fork tiers en prod ou reproduction du verifier dans 3ème langue

## Kill switch empirique

Pendant 30 premiers jours en prod : si < 100 lookups/jour, < 80% taux de succès, ou aucun pubkey externe → admettre que le marché DIY ou les concurrents (Amboss, mempool) gagnent → arrêter.

## Question round 7

Cette spec **SatRank Routing V1.0** rend-elle SatRank techniquement saine (SPEC_VALIDE) **ET** indispensable pour un agent IA Bitcoin-souverain 2030 qui fait 100-1000 paiements Lightning par jour (INDISPENSABLE) ?
