# Phase 2 — Livrable : Anonymous reports via `preimage_pool`

**Date** : 2026-04-18
**Branche** : `phase-2-anonymous-report` (à merger dans `main`)
**Schema** : v32 (ajout table `preimage_pool`)
**Référence design** : `docs/PHASE-2-ANONYMOUS-REPORT-DESIGN.md`

---

## 1. Chaîne des 7 commits

| # | SHA | Sujet |
| --- | --- | --- |
| 1 | `915fb33` | `feat(db): v32 preimage_pool table + migration tests` |
| 2 | `35d622f` | `feat(utils): bolt11Parser + tests` |
| 3 | `49ac640` | `feat(repo): preimagePoolRepository + tests` |
| 4 | `7dc6414` | `feat(crawler+decide): voies 1 & 2 alimentent preimage_pool` |
| 5 | `d1c93d3` | `feat(report): voie 3 — /api/report anonyme via preimage_pool` |
| 6 | `9f4fc29` | `test(phase-2): intégration sim #11 replay + concurrence one-shot` |
| 7 | _this_ | `docs(phase-2): design + livrable` |

---

## 2. Critère d'acceptation

Synthetic agent pays L402 → obtient preimage → `POST /api/report` avec `X-L402-Preimage` + `bolt11Raw` (ou pool déjà peuplé par voie 1/2) + `outcome` → reçoit `200` avec :

```json
{
  "data": {
    "reportId": "<uuid>",
    "verified": true,
    "weight": 0.5,
    "timestamp": 1776519...,
    "reporter_identity": "preimage_pool:<payment_hash>",
    "confidence_tier": "medium",
    "reporter_weight_applied": 0.5
  }
}
```

Second call avec la même preimage → `409 DUPLICATE_REPORT`.

**Sim #11 replay vérifié** dans `src/tests/anonymousReport/integration-sim11.test.ts` :
- step 1 crawler peuple pool medium/crawler,
- step 2 agent POST /api/report anonyme avec preimage,
- step 3 attestation créée, pool entry consommée, `consumer_report_id` = reportId du 200.

---

## 3. Métriques & observabilité

- `reportSubmittedTotal{verified="1", outcome="<success|failure|timeout>"}` — compteur Prometheus existant, incrémenté à chaque report anonyme (toujours `verified=1` car preimage prouvée).
- `rateLimitHits{limiter="report"}` — bumpé à `20/min/IP` au lieu de `5` pour cohabiter avec le chemin anonyme sans friction.
- Pas de nouvelle métrique dédiée : la distinction anonyme vs legacy se lit via `transactions.source='report'` × agent synthétique (source `manual`, alias préfixé `anon:`).

Requête diagnostique recommandée après activation :
```sql
SELECT DATE(timestamp, 'unixepoch') AS day,
       COUNT(*) AS anonymous_reports
  FROM attestations a
  JOIN transactions t ON t.tx_id = a.tx_id
  JOIN agents ag ON ag.public_key_hash = a.attester_hash
 WHERE t.source = 'report'
   AND ag.source = 'manual'
   AND ag.alias LIKE 'anon:%'
 GROUP BY day
 ORDER BY day;
```

---

## 4. Tests

**26 tests Phase 2** tous verts en local :

```
src/tests/anonymousReport/
├── bolt11Parser.test.ts              (5 tests)
├── preimagePoolRepository.test.ts    (8 tests)
├── voies12-pool-feed.test.ts         (5 tests)
├── voie3-anonymous-report.test.ts    (8 tests)
└── integration-sim11.test.ts         (2 tests)
```

Suite complète du projet : `npm test` vert après les 7 commits.

---

## 5. Rollout

Aucune feature flag : le chemin anonyme est actif dès le merge. Critère de rollback :
- spike de `rateLimitHits{limiter="report"}` > 10× baseline → investiguer abus
- spike d'`attestations` avec `reporter.alias LIKE 'anon:%'` > 50× baseline → éventuellement ajouter un flag `ANONYMOUS_REPORTS_ENABLED` et flipper à `false`.

Migration v32 SQL-idempotente (INSERT OR IGNORE, `IF NOT EXISTS` sur la table et les indexes). Rollback down migration teste le drop propre dans `migrations.test.ts`.

---

## 6. Points ouverts

- **Tier `high`** : provisionné mais aucun code ne l'écrit. Future voie candidate (pré-signature LND opérateur).
- **Purge synthetic agents** : chaque preimage consommée crée une ligne dans `agents`. À terme, purge après N jours d'inactivité.
- **Rate-limit par `paymentHash`** : non implémenté — `consumed_at` sérialise naturellement les tentatives.

---

## 7. Prochaine étape

Merge `phase-2-anonymous-report` → `main` après review de Romain, puis deploy standard (pas de flag env à flipper).
