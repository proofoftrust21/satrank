# Phase 1 — Dual-write `transactions` design

**Date** : 2026-04-17
**Branche** : `phase-1-dual-write` (basée sur `phase-0-audit` → `bcdc331`)
**Base schema** : v30 (588 tests verts)
**Scope** : spec technique avant code. Valider ce doc avant toute migration SQL ou code applicatif.

Cadre : §Phase 1 de `BLUEPRINT-MIGRATION-PLAN.md` lignes 133-143. Contraintes Romain :
- Suivre à la lettre la spec BLUEPRINT Phase 1.
- 4 colonnes seulement (pas de nouvelle table).
- Backfill séparé.
- Tests d'idempotence par module dual-writer.
- CI verte à chaque commit.
- Aucun commit sur main.
- Livrable final : `PHASE-1-DUAL-WRITE-REPORT.md` avec métrique de dérive < 0.1 % sur 48-72h de dry-run.

---

## 1. Migration v31 — schéma

Fichier : `src/database/migrations.ts` (append après `recordVersion(db, 30, …)`).

```sql
-- v31
ALTER TABLE transactions ADD COLUMN endpoint_hash TEXT;
ALTER TABLE transactions ADD COLUMN operator_id   TEXT;
ALTER TABLE transactions ADD COLUMN source        TEXT
  CHECK(source IS NULL OR source IN ('probe', 'observer', 'report', 'intent'));
ALTER TABLE transactions ADD COLUMN window_bucket TEXT;

CREATE INDEX IF NOT EXISTS idx_transactions_endpoint_window
  ON transactions(endpoint_hash, window_bucket);
CREATE INDEX IF NOT EXISTS idx_transactions_operator_window
  ON transactions(operator_id,   window_bucket);
CREATE INDEX IF NOT EXISTS idx_transactions_source
  ON transactions(source);
```

### 1.1 Sémantique des colonnes

| Colonne | Type | Nullability | Formation | Commentaire |
|---|---|---|---|---|
| `endpoint_hash` | TEXT | NULL autorisé | `sha256hex(canonicalizeUrl(service_endpoints.service_url))` — cf. §1.3 | NULL pour tx Observer agent↔agent off-chain (pas d'endpoint concerné). |
| `operator_id`   | TEXT | NULL autorisé | `sha256hex(service_endpoints.node_pubkey)` | NULL si endpoint sans node mappé ou tx Observer pur. Pas de sentinel `'unknown'` (préserve la sémantique SQL pour GROUP BY/jointures Phase 7). |
| `source`        | TEXT | NULL autorisé | `'probe' \| 'observer' \| 'report' \| 'intent'` | NULL = ligne legacy pré-v31 (tant que backfill incomplet). |
| `window_bucket` | TEXT | NULL autorisé | `date(timestamp, 'unixepoch')` → `YYYY-MM-DD` UTC | Dérivable déterministiquement de `timestamp`. NOT NULL pourra être imposé en v32 après backfill complet. |

Raison des NULL autorisés : migration *additive*, aucune rupture. La contrainte `CHECK` sur `source` laisse passer NULL pour les lignes historiques non-backfillées.

### 1.3 Canonicalisation `service_url` (utilitaire `src/utils/urlCanonical.ts`)

Deux URLs qui pointent vers le même service doivent produire le même `endpoint_hash`. Règles strictes (RFC 3986 canonical form) :

1. Scheme → **lowercase**.
2. Host → **lowercase** (IDN : `toASCII` via Punycode avant lowercase).
3. Port → **supprimé** si c'est le port par défaut du scheme (`80` pour `http`, `443` pour `https`). Conservé sinon.
4. Path → **trailing slash retiré** sauf si le path est exactement `/`.
5. Query string → **supprimée** intégralement.
6. Fragment → **supprimé** intégralement.
7. Userinfo (`user:pass@`) → **supprimé**.
8. Percent-encoding → **décodé** pour les caractères non-réservés (`A-Z a-z 0-9 - . _ ~`), conservé pour les réservés. Casse des triplets percent normalisée en uppercase (`%2f` → `%2F`).

Signature :
```ts
export function canonicalizeUrl(raw: string): string  // throws on malformed input
export function endpointHash(raw: string): string    // sha256hex(canonicalizeUrl(raw))
```

Tests requis (≥ 10 cas) — fichier `src/tests/urlCanonical.test.ts` :
- port par défaut (`https://x.com:443/a` → `https://x.com/a`)
- port non-défaut (`http://x.com:8080/a` → conservé)
- casse scheme (`HTTPS://x.com/a` → `https://x.com/a`)
- casse host (`https://X.com/A` → `https://x.com/A` ; le path reste case-sensitive)
- trailing slash (`https://x.com/a/` → `https://x.com/a` ; mais `https://x.com/` → `https://x.com/`)
- query stripping (`https://x.com/a?b=1` → `https://x.com/a`)
- fragment stripping (`https://x.com/a#top` → `https://x.com/a`)
- userinfo stripping (`https://user:pass@x.com/a` → `https://x.com/a`)
- IDN (`https://café.example/a` → `https://xn--caf-dma.example/a`)
- percent casing (`https://x.com/%2fabc` → `https://x.com/%2Fabc`)
- percent decoding non-réservé (`https://x.com/%7Etilde` → `https://x.com/~tilde`)
- malformed → throws (`not-a-url`, `://missing-scheme`, etc.)

Implémenté en stdlib Node (`URL` + manual touch-up) — pas de dépendance externe.

### 1.4 Rollback

```sql
-- rollback v31
DROP INDEX IF EXISTS idx_transactions_source;
DROP INDEX IF EXISTS idx_transactions_operator_window;
DROP INDEX IF EXISTS idx_transactions_endpoint_window;
-- SQLite ne supporte pas DROP COLUMN avant 3.35 (OK sur notre target) :
ALTER TABLE transactions DROP COLUMN window_bucket;
ALTER TABLE transactions DROP COLUMN source;
ALTER TABLE transactions DROP COLUMN operator_id;
ALTER TABLE transactions DROP COLUMN endpoint_hash;
```

À intégrer dans `scripts/rollback.ts` via le chemin existant (lecture de `schema_version` descendant).

---

## 2. Flag dual-write

Fichier : `src/config/env.ts` (ou équivalent).

| Env var | Valeurs | Défaut | Sémantique |
|---|---|---|---|
| `TRANSACTIONS_DUAL_WRITE_MODE` | `off` \| `dry_run` \| `active` | `off` | Contrôle le comportement. |
| `TRANSACTIONS_DRY_RUN_LOG_PATH` | path absolu | `/var/log/satrank/dual-write-dryrun.ndjson` | Destination du log NDJSON en mode `dry_run`. |

**Comportement** :
- `off` : seul le chemin legacy écrit dans `transactions`. Les 4 nouvelles colonnes restent NULL. Mode par défaut pendant le dev/CI.
- `dry_run` : le chemin legacy écrit comme aujourd'hui. En parallèle, chaque module *calcule* l'enrichissement (`endpoint_hash`, `operator_id`, `source`, `window_bucket`) et **logue** la ligne qui *serait* insérée dans NDJSON. **Aucune** écriture des 4 colonnes en base.
- `active` : **un seul INSERT** par tx, qui inclut d'emblée les 4 colonnes enrichies en plus des colonnes legacy. Pas de deux writes successifs, pas de seconde mutation. Élimine les races et l'inconsistance partielle. Plus de log NDJSON (ou log réduit si `TRANSACTIONS_DUAL_WRITE_AUDIT_SAMPLE_PCT` > 0).

**Important** : un seul chemin d'écriture logique par tx. On ne duplique pas la ligne — en mode `active` l'INSERT couvre les 9 colonnes legacy + les 4 nouvelles dans une seule opération. En mode `dry_run`, l'INSERT legacy (9 colonnes) se produit normalement et les 4 nouvelles sont simulées en NDJSON.

### 2.1 Path log — setup container et fallback

Le service tourne en container Docker. Le path par défaut `/var/log/satrank/dual-write-dryrun.ndjson` **nécessite** un volume monté :

```yaml
# docker-compose.yml (extrait, Phase 1)
services:
  satrank:
    volumes:
      - /var/log/satrank:/var/log/satrank
```

Côté host (déploiement) :
```bash
sudo mkdir -p /var/log/satrank
sudo chown -R <uid-satrank>:<gid-satrank> /var/log/satrank
sudo chmod 750 /var/log/satrank
```

Au démarrage de l'app, le logger :
1. Tente `mkdir -p` sur le directory du `TRANSACTIONS_DRY_RUN_LOG_PATH` configuré.
2. Tente une écriture de test (fichier `.write-test` + suppression).
3. Si l'étape 1 ou 2 échoue (permission denied, volume non-monté, filesystem read-only) :
   - **Fallback** sur `process.cwd() + '/logs/dual-write-dryrun.ndjson'`.
   - Log pino WARN au démarrage : `"dualWrite.logPath fallback: <configured> not writable, using <fallback>"`.
   - Si le fallback lui-même échoue, log pino ERROR et désactive le dry-run logging (mais n'interrompt pas le démarrage — la legacy continue).
4. Log pino INFO au démarrage avec le path effectif utilisé.

**Documentation deploy** : le présent doc sert de source pour le runbook Phase 1. Lors du push en prod, rappeler la création manuelle du volume + permissions avant restart.

---

## 3. Format NDJSON (mode dry_run)

Chaque ligne = 1 JSON objet, `\n` en fin. Encoding UTF-8, pas de BOM.

```json
{
  "emitted_at": 1713380000,
  "source_module": "crawler",
  "would_insert": {
    "tx_id": "obs-tx-abc123",
    "sender_hash": "<64-hex>",
    "receiver_hash": "<64-hex>",
    "amount_bucket": "micro",
    "timestamp": 1713379995,
    "payment_hash": "<64-hex>",
    "preimage": null,
    "status": "verified",
    "protocol": "l402",
    "endpoint_hash": "<64-hex or null>",
    "operator_id": "<64-hex or null>",
    "source": "observer",
    "window_bucket": "2026-04-17"
  },
  "legacy_inserted": true,
  "trace_id": "<uuid v4 optionnel>"
}
```

**Champs** :
- `emitted_at` : unix seconds, instant du log (≠ `timestamp` interne à la tx).
- `source_module` : `crawler` | `reportService` | `decideService` | `serviceProbes`.
- `would_insert` : payload complet y compris les 4 nouvelles colonnes enrichies.
- `legacy_inserted` : `true` si le chemin legacy a inséré cette tx en base (permet de détecter les incohérences).
- `trace_id` : optionnel, permet de corréler quand un même event passe par plusieurs modules.

Rotation : hors scope Phase 1 (logrotate Linux suffira initialement). Path mkdir récursif au démarrage si absent.

---

## 4. Modules dual-writers

4 modules distincts appellent `TransactionRepository.insert(...)` aujourd'hui ou doivent le faire en Phase 1.

| Module | Fichier | Calcule enrichissement depuis | `source` |
|---|---|---|---|
| Observer crawler | `src/crawler/crawler.ts:143` | event observer (pas d'endpoint → `endpoint_hash = NULL`, `operator_id = NULL`) | `'observer'` |
| Service probes crawler | `src/crawler/serviceHealthCrawler.ts` (nouveau call) | URL probée → `endpoint_hash = canonicalize+sha256(url)`, node_pubkey mappé → `operator_id` | `'probe'` |
| Report service | `src/services/reportService.ts` | target_url du report → `endpoint_hash`, opérateur déduit | `'report'` |
| Decide outcome writer | `src/services/reportService.ts` (outcome observé via `/report`) **et** `src/services/decideLogTimeoutWorker.ts` (nouveau worker, outcome par expiration) | `decide_log.target_url` + outcome final → enrichissement | `'intent'` |

**Déclencheur `source='intent'`** — 3 cas exhaustifs :
1. **Preimage vérifiée** : l'agent confirme le paiement via `/api/report` avec preimage valide → INSERT tx avec `source='intent'`, `status='verified'`, lien vers `decide_log` via `tx_id`.
2. **Échec explicite** : l'agent déclare l'échec via `/api/report` (ex. 402 non payable, service down côté agent, timeout réseau) → INSERT tx avec `source='intent'`, `status='failed'`.
3. **Outcome jamais observé** : l'agent appelle `/decide` puis disparaît. Le worker `decideLogTimeoutWorker` scanne `decide_log` et, pour chaque entrée dont `created_at < now - INTENT_OUTCOME_TIMEOUT_HOURS` (défaut 24h) et sans tx liée, **n'écrit rien**. La ligne `decide_log` reste trace d'une intention non-résolue ; pas de pollution de `transactions`.

**Ce que `/decide` seul n'écrit PAS** : `/decide` crée uniquement une ligne dans `decide_log` (comportement v30 existant). L'INSERT dans `transactions` vient plus tard, à l'outcome observé — pas au moment de l'intent. Évite 80-90 % de bruit (ratio observé : la majorité des `/decide` ne sont pas suivis d'un `/report`).

**Idempotence** : chaque module emploie `INSERT OR IGNORE` sur `tx_id` (déjà le cas pour l'observer). Les tests d'idempotence rejouent le même event 2× et vérifient 1 seule ligne en base. Pour le worker timeout, idempotence = pas d'écriture du tout.

---

## 5. Backfill — script séparé

Fichier : `scripts/backfillTransactionsV31.ts`.

Sources & mapping :
- `probe_results` → tx avec `source='probe'`, `endpoint_hash = sha256(target_url)`, `timestamp = probe.ts`, `status` dérivé de `reachable`.
- `service_probes` → tx avec `source='probe'`, `endpoint_hash = sha256(url)`, tier d'amount → `amount_bucket`, `status` dérivé du probe outcome.
- `attestations` → pas une source directe de `transactions` (les attestations référencent déjà un `tx_id` existant). Le backfill ici **enrichit** les tx référencées si leurs nouvelles colonnes sont encore NULL.

Critères d'écriture :
- Chunks de 1 000 lignes.
- Checkpoint dans un fichier `.backfill-transactions-v31.checkpoint.json` (dernier `rowid` traité par source).
- Idempotent : `UPDATE transactions SET endpoint_hash=?, operator_id=?, source=?, window_bucket=? WHERE tx_id=? AND endpoint_hash IS NULL` → n'écrase jamais une ligne déjà enrichie.
- Dry-run mode (`--dry-run`) qui compte sans écrire.
- Zéro couplage avec le flag `TRANSACTIONS_DUAL_WRITE_MODE` — script standalone.

---

## 6. Script d'audit dry-run

Fichier : `scripts/auditDualWriteDryrun.ts`.

Entrée : fichier NDJSON (argument CLI ou stdin).

Calcule et imprime :
- Volume total de lignes loggées.
- Distribution par `source_module` (counts + %).
- Distribution par `source` (counts + %).
- Taux de `endpoint_hash IS NULL` et de `operator_id IS NULL`.
- Alignement `window_bucket` vs `date(timestamp)` — doit être 100 %. Toute ligne où ça diverge = bug enrichissement.
- Sampling : imprime 10 lignes random pour inspection visuelle.
- Taux `legacy_inserted: false` (lignes simulées mais dont la legacy n'a pas inséré) — doit être < 0.1 %.
- Exit code : 0 si cohérence > 99.9 %, 1 sinon.

---

## 7. Tests

| Fichier | Couverture |
|---|---|
| `src/tests/dualWrite/migration-v31.test.ts` | Migration v31 applicable et réversible. Schéma final correct. |
| `src/tests/dualWrite/mode-off.test.ts` | Mode `off` : INSERT legacy comme avant, 4 colonnes NULL. |
| `src/tests/dualWrite/mode-dryRun.test.ts` | Mode `dry_run` : INSERT legacy, NDJSON écrit, 4 colonnes NULL en base. |
| `src/tests/dualWrite/mode-active.test.ts` | Mode `active` : INSERT legacy + 4 colonnes peuplées. Pas de NDJSON. |
| `src/tests/dualWrite/idempotence-crawler.test.ts` | Observer crawler : même event 2× → 1 ligne. |
| `src/tests/dualWrite/idempotence-reportService.test.ts` | Report : même tx_id 2× → 1 ligne, dernières colonnes préservées. |
| `src/tests/dualWrite/idempotence-decideService.test.ts` | Decide → écriture tx sur outcome observé, 2× → 1 ligne. |
| `src/tests/dualWrite/idempotence-serviceProbes.test.ts` | Service probes : même probe 2× → 1 ligne. |
| `src/tests/dualWrite/backfill.test.ts` | Backfill rejouable, ne récrase pas, progresse sur checkpoint. |
| `src/tests/dualWrite/audit-script.test.ts` | Script d'audit : lit NDJSON synthétique, retourne métriques correctes. |

Total prévu : 10 nouveaux tests. Existants : 588 doivent rester verts.

---

## 8. Séquencement des commits sur `phase-1-dual-write`

1. `docs: Phase 1 design doc` (ce fichier) — pour relecture avant code.
2. `feat(db): v31 migration — transactions +4 columns + indexes` + test migration.
3. `feat(config): TRANSACTIONS_DUAL_WRITE_MODE flag + NDJSON logger` + tests modes off/dry_run/active.
4. `feat(crawler): dual-write source=observer` + test idempotence.
5. `feat(crawler): dual-write source=probe` + test idempotence.
6. `feat(report): dual-write source=report` + test idempotence.
7. `feat(decide): dual-write source=intent` + test idempotence.
8. `feat(scripts): backfillTransactionsV31 standalone` + test.
9. `feat(scripts): auditDualWriteDryrun` + test.
10. `docs: Phase 1 dual-write report — 48-72h dry-run results`.

CI (`npm run lint && npm test`) verte à **chaque** commit.

---

## 9. Critères de bascule `dry_run` → `active`

Avant bascule, tous vrais :
- Backfill v31 complet (0 ligne `transactions` avec `endpoint_hash IS NULL` et non-Observer).
- Script d'audit dry-run produit cohérence > 99.9 % sur ≥ 48h de prod.
- 10 tests Phase 1 verts + 588 existants.
- Relecture Romain du rapport `PHASE-1-DUAL-WRITE-REPORT.md`.

Bascule = `systemctl set-environment TRANSACTIONS_DUAL_WRITE_MODE=active` + restart. Rollback = set `off` + restart.

---

## 10. Décisions validées (2026-04-17)

Les 5 questions ouvertes ont été tranchées par Romain :

1. **`service_url` canonicalization** : **RFC 3986 strict** (cf. §1.3 ci-dessus). Utilitaire dédié `src/utils/urlCanonical.ts` + `src/tests/urlCanonical.test.ts` (≥ 10 cas). Implémenté en stdlib Node, sans dépendance externe.
2. **`operator_id` sans `node_pubkey`** : **NULL** (pas de sentinel `'unknown'`). Préserve la sémantique SQL pour GROUP BY / jointures Phase 7.
3. **Mode `active` — single INSERT** : **un seul INSERT par tx**, 13 colonnes (9 legacy + 4 enrichies). Pas de deux writes. Évite races et inconsistance partielle.
4. **`source='intent'` déclencheur** : **outcome observé uniquement** — 3 cas exhaustifs (preimage verified / explicit failure / outcome never observed = no write). Déclencheurs réels : `/api/report` (cas 1 et 2) + `decideLogTimeoutWorker` (cas 3, ne produit aucune écriture). `/decide` seul n'écrit rien dans `transactions`.
5. **Path log** : `/var/log/satrank/dual-write-dryrun.ndjson` via **volume Docker monté**. Fallback `process.cwd() + '/logs/'` si volume non-writable, avec WARN au démarrage. Setup deploy documenté §2.1.

---

**Statut** : design validé, 5 décisions appliquées. Prochaine étape immédiate : Commit 2 (migration v31 + test).
