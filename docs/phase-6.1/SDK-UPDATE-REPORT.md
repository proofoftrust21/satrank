# Phase 6.1 — SDK Update Report (final)

**Branche :** `phase-6.1-sdk`
**Date :** 2026-04-22
**Durée réelle :** ~2h (vs. 6.5h estimé en S1)
**Statut :** prêt à publier — **manual GATE non franchie**

---

## Livraisons

| SDK                | Version RC  | Version GA | Artefact local                                       |
|--------------------|-------------|------------|------------------------------------------------------|
| `@satrank/sdk`     | `1.0.0-rc.1`| `1.0.0`    | `sdk/satrank-sdk-1.0.0.tgz` (40.3 kB, 58 files)      |
| `satrank` (Python) | `1.0.0rc1`  | `1.0.0`    | `python-sdk/dist/satrank-1.0.0-py3-none-any.whl` + `satrank-1.0.0.tar.gz` |

---

## Étapes exécutées

### S1 — Audit drift (complet)

Document : `docs/phase-6.1/SDK-DRIFT-AUDIT.md`

5 drifts identifiés, classifiés :
1. **MINOR** — narratif "AI agents" → "autonomous agents on Bitcoin Lightning" (3 fichiers de description)
2. **BREAKING-docs** — README TS désaligné (documentait la classe `SatRankClient` 0.x inexistante)
3. **MINOR** — union `AdvisoryBlock.recommendation` incomplète (3 valeurs au lieu de 4)
4. **NO-OP** — Phase 12C enum sunset transparent au SDK (0 références)
5. **PATCH** — `ApiClient.getAgentVerdict()` mort-code

### S2 — Port TypeScript (complet)

Fichiers modifiés dans `sdk/` :
- `src/types.ts` → ajout `"consider_alternative"` à `AdvisoryBlock.recommendation`
- `src/client/apiClient.ts` → suppression `getAgentVerdict()`
- `package.json` → `1.0.0-rc.1` → `1.0.0`, description updated
- `README.md` → réécriture complète (180 lignes) pour la surface `SatRank` 1.0

Validation : `npm run build` ✅, `npm test` → 125/125 ✅, `npm run lint` ✅.

### S3 — Port Python (complet)

Fichiers modifiés dans `python-sdk/` :
- `satrank/types.py` → ajout `"consider_alternative"` au Literal
- `pyproject.toml` → version `1.0.0rc1` → `1.0.0`, description updated
- `satrank/__init__.py` → `__version__ = "1.0.0"`

Validation : `pytest` → 116/116 ✅, `mypy --strict` ✅, `ruff check` ✅.

Note : `python-sdk/README.md` était déjà aligné (1.0 narrow), aucune réécriture nécessaire.

### S4 — Intégration prod (complet)

Document : `docs/phase-6.1/SDK-INTEGRATION-TEST.md`

- `/api/health` → 200 (schema v41, 8186 agents, dbStatus=ok, lndStatus=ok)
- `/api/intent/categories` → 200 `{ categories: [] }` (registry vide mais shape OK)
- `POST /api/intent` sur catégorie inconnue → 400 `INVALID_CATEGORY` → `ValidationSatRankError` dans les 2 SDKs
- `/api/agents/top` → 200 (hors surface SDK, vérifié pour référence)

Pas de STOP condition. Flow fulfill() non exercé (pas de wallet, pas de LN op).

### S5 — Artefacts locaux (complet)

Commandes exécutées :
- `cd sdk && npm pack` → `satrank-sdk-1.0.0.tgz`
- `cd python-sdk && python -m build` → `.whl` + `.tar.gz`

Livrables additionnels :
- `sdk/CHANGELOG.md` (nouveau)
- `python-sdk/CHANGELOG.md` (nouveau)
- `docs/phase-6.1/RELEASE-NOTES-DRAFT.md` (nouveau)

### S6 — Report + PR #15 (en cours)

Ce document + commit sur `phase-6.1-sdk` + push + draft PR.

---

## Anomalie notée (non-blocking)

Divergence cross-SDK préexistante sur `error.code` pour les statuts HTTP connus :
- **Python** préserve le `code` serveur verbatim (ex. `INVALID_CATEGORY`)
- **TypeScript** substitue le `code` par défaut de classe (ex. `VALIDATION_ERROR`)

Les consommateurs qui utilisent `instanceof` (voie recommandée dans les deux READMEs) ne sont pas affectés. Reconcilier casse l'un ou l'autre → reporté post-1.0.

---

## PUBLISH GATE — statut

**FERMÉE.** Aucune des 4 commandes interdites n'a été exécutée :
- ❌ `npm publish`
- ❌ `twine upload`
- ❌ `gh release create`
- ❌ `git tag v*` + `git push origin v*`

Checklist de publication manuelle disponible dans `docs/phase-6.1/RELEASE-NOTES-DRAFT.md`. Romain ouvre la GATE.

---

## Règle LND

Aucune opération LN effectuée. `LnurlWallet` / `NwcWallet` / `LndWallet` : tests unitaires avec mocks uniquement.
