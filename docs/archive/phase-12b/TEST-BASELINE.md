# Phase 12B — Test baseline (pre-migration)

**Date :** 2026-04-21 14:10 local
**Branch :** `phase-12b-postgres` (head : `de8441d`)
**Command :** `npm test -- --run`

## Totaux

| Metric | Count |
|---|---:|
| Test files | 126 |
| Tests (total) | 1 452 |
| **Passing** | **1 451** |
| **Failing** | **1** |
| Skipped | 0 |
| Duration | 54.30 s |

## Échec connu (pré-existant)

`src/tests/probeRateLimit.test.ts:110` — test `ProbeRateLimit — per-token > increments the probe_per_token metric on rejection` :

```
AssertionError: expected 1 to be 2
- Expected: 2
+ Received: 1
```

Off-by-one sur le compteur Prometheus `probe_per_token`. Pré-existe avant Phase 12B (rien n'a été touché dans ce code ici). À traiter séparément — pas un blocker de migration.

## Critère post-B3 (décision Romain, point C)

Même ratio passing attendu : **1 451 passing / 1 failing (ce même flaky) / 0 skipped**.
- Si un nouveau test échoue après migration → blocker B3
- Si le flaky `probeRateLimit` reste rouge → acceptable (identique au baseline)
- Si le flaky devient vert → bénéfice collatéral, noter mais pas bloquer
