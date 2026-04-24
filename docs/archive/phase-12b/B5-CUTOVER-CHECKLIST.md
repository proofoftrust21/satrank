# Phase 12B — B5 Pre-cutover checklist (corrigée)

**Date:** 2026-04-21
**Branch:** `phase-12b-postgres`
**Commit anchor:** B3.d (b1239aa) — 0 failed / 1041 passed / 312 skipped
**Type de cut-over:** big-bang (SQLite → Postgres 16), rollback = snapshot SQLite + restart container
**Statut:** **EN ATTENTE GO utilisateur** — ne rien lancer avant validation explicite

---

## 0. Pré-requis locaux (déjà validés)

- [x] `npm test` → 0 failed / 1041 passed
- [x] `npm run build` → 0 erreur
- [x] `npx tsc --noEmit` (src/**, tests exclus) → 0 erreur
- [x] Zones critiques à 0 failure : bayesianValidation, verdictAdvanced,
      security, attestation, scoring, decide, intentApi, probe, nostr
- [x] Commit B3.d scellé : `b1239aa feat(phase-12b): B3.d crawler/scripts/tests harness port + test debt 0 failure`

---

## 1. Vérifications pré-cut-over (prod, sans modification)

### 1.1 Schema version

- [ ] Lire `src/database/migrations.ts` → `CONSOLIDATED_VERSION = 41`
- [ ] Confirmer que `migrations.ts` applique `src/database/postgres-schema.sql`
      en **one-shot idempotent** et insère `schema_version (41, …)`
- [ ] **Note** : le "v29+phase7-9" mentionné dans l'audit B0 était l'état SQLite
      **pré-consolidation**. La version canonique Postgres est **v41**. C'est la
      seule version que la migration produit.

### 1.2 seedBootstrap — mode dry-run

- [ ] `npx tsx src/scripts/seedBootstrap.ts --dry-run`
- [ ] Vérifier log attendu sur DB vierge :
      ```
      action=WOULD_INSERT × 5 (un par deposit_tier : 21, 1000, 10000, 100000, 1000000)
      summary: { depositTiersInserted: 5, depositTiersExisting: 0, dryRun: true }
      ```
- [ ] Sur DB déjà seedée, attendre : `action=SKIP_EXISTING × 5`
- [ ] Le flag `--dry-run` a été ajouté en B3.d commit b1239aa+seed ; aucun INSERT
      n'est exécuté en mode dry-run (vérifications via `SELECT COUNT(*)`).

### 1.3 Backup SQLite pré-cut-over (one-liner, pas de script dédié)

Les scripts `npm run backup` / `backup:prod` existants pointent vers **Postgres**
(`pg_dump`). Ils ne s'appliquent pas à l'état SQLite pré-cut-over.

**Chemin réel du DB prod** : la base vit dans le volume Docker nommé
`satrank_satrank-data`, monté sur l'hôte sous `/var/lib/docker/volumes/…/_data/`.
Audit B0 confirme : `/var/lib/docker/volumes/satrank_satrank-data/_data/satrank.db`.

**Procédure retenue** (sans script custom, préserve l'atomicité SQLite) :

- [ ] Résoudre le mountpoint exact (double-check : le volume peut avoir été
      renommé depuis B0) :
      ```
      ssh root@178.104.108.108 \
        'docker volume inspect satrank_satrank-data --format "{{.Mountpoint}}"'
      ```
      → attendre `/var/lib/docker/volumes/satrank_satrank-data/_data`
      → noter ici : `SQLITE_DIR = _____________________`
      Si le volume porte un autre nom (ex: `satrank_data`), adapter les commandes
      ci-dessous avec le `SQLITE_DIR` effectif.
- [ ] Vérifier la présence du fichier :
      ```
      ssh root@178.104.108.108 \
        'ls -lh /var/lib/docker/volumes/satrank_satrank-data/_data/satrank.db'
      ```
- [ ] Snapshot atomique SQLite (`.backup` respecte WAL, n'interrompt pas les
      writers) :
      ```
      ssh root@178.104.108.108 \
        "mkdir -p /root/snapshots && \
         sqlite3 /var/lib/docker/volumes/satrank_satrank-data/_data/satrank.db \
           \".backup '/root/snapshots/satrank-pre-cutover-$(date -u +%Y%m%dT%H%M%SZ).db'\" && \
         ls -lh /root/snapshots/satrank-pre-cutover-*.db | tail -1"
      ```
- [ ] Checksum du backup :
      ```
      ssh root@178.104.108.108 \
        "sha256sum /root/snapshots/satrank-pre-cutover-*.db | tail -1"
      ```
      → noter le hash ici : `_____________________`
- [ ] Taille du backup non nulle et > taille prod live (ou égale, tolérance 5%) :
      comparer avec la taille affichée par `ls -lh` de l'étape précédente.

### 1.4 Connectivité Postgres — résolution depuis le container api

**Setup réel** (audit B1/B2 confirmé par `infra/phase-12b/vm-state.md`) :
- `satrank-postgres` est une **VM Hetzner séparée** (cpx42, nbg1) — pas un
  container colocated.
- IPv4 publique : **`178.104.142.150`**
- UFW rule postgres VM : `5432/tcp ALLOW from 178.104.108.108` (seule origine
  autorisée = VM prod SatRank API)
- **Pas de Hetzner Private Network / pas de DNS interne** — la résolution
  `satrank-postgres` (hostname) ne fonctionne QUE depuis la VM postgres
  elle-même, pas depuis le container api sur l'autre VM.
- **Cas applicable : (b) IPv4 publique + firewall whitelist**

**Vérifications à exécuter depuis prod api avant §2** :

- [ ] Connectivité TCP brute :
      ```
      ssh root@178.104.108.108 \
        'nc -vz 178.104.142.150 5432'
      ```
      → attendre `Connection to 178.104.142.150 5432 port [tcp/postgresql] succeeded!`
- [ ] Auth Postgres (password dans `infra/phase-12b/secrets/pg_password`, file
      mode 600, gitignored) :
      ```
      ssh root@178.104.108.108 \
        'PGPASSWORD=$(cat /root/secrets/pg_password) \
         psql -h 178.104.142.150 -U satrank -d satrank -c "SELECT version();"'
      ```
      → attendre ligne `PostgreSQL 16.13 …`
- [ ] Depuis le container api (une fois le code B3.d déployé et image rebuild,
      mais `.env` encore sur SQLite — donc on exec directement) :
      ```
      ssh root@178.104.108.108 \
        'docker exec satrank-api getent hosts 178.104.142.150 || \
         docker exec satrank-api sh -c "apk add --no-cache postgresql-client && \
           PGPASSWORD=*** psql -h 178.104.142.150 -U satrank -d satrank -c \"SELECT 1\""'
      ```
      → vérifier que le container peut atteindre la VM postgres en TCP direct
        (même network host que la VM prod, pas de NAT sortant bloquant).
- [ ] **Connection string canonique à utiliser en §2.4** :
      ```
      DATABASE_URL=postgres://satrank:<pg_password>@178.104.142.150:5432/satrank
      ```
      Le password provient du fichier scellé sur la VM prod (copié depuis
      `infra/phase-12b/secrets/pg_password` local via rsync B3.a, ou
      re-synchronisé avant §2).

### 1.5 Rollback plan (validé avant cut-over, pas exécuté)

Si le cut-over Postgres échoue après bascule :
1. Stopper le container satrank-api : `docker compose stop api`
2. Restaurer `.env` : remettre `DATABASE_URL=file:/app/data/satrank.db`
   (chemin interne container, le volume `satrank_satrank-data` mappe
   `/app/data` → `/var/lib/docker/volumes/satrank_satrank-data/_data`) —
   commenter/retirer les vars pg.
3. Restart : `docker compose up -d api --force-recreate`
4. Le snapshot `/root/snapshots/satrank-pre-cutover-<timestamp>.db` est la
   source de vérité si le `satrank.db` live a été altéré pendant la fenêtre
   de cut-over (peu probable — aucun write prod pendant §2, mais garde-fou).
5. Vérifier `/api/health` 200 OK avant de relâcher.

- [ ] Procédure rollback lue et validée par l'opérateur cut-over **avant** B5.

---

## 2. Exécution cut-over (big-bang)

**Autorisation requise :** GO explicite utilisateur. Pas de lancement sans validation.

1. [ ] Backup SQLite (section 1.3 exécutée)
2. [ ] Déploiement code B3.d sur prod : `make deploy` (respecte `.rsync-exclude`)
3. [ ] Rebuild Docker image : `ssh root@178.104.108.108 'cd /root/satrank && docker compose build api'`
4. [ ] Configurer `.env` prod avec :
       ```
       DATABASE_URL=postgres://satrank:<pg_password>@178.104.142.150:5432/satrank
       ```
       (IPv4 publique VM `satrank-postgres`, firewall UFW whitelist 178.104.108.108
       déjà en place — voir §1.4 pour tests de résolution préalables)
5. [ ] Lancer migrations :
       `ssh root@178.104.108.108 'cd /root/satrank && docker compose run --rm api node dist/scripts/runMigrations.js'`
       → attendre log "schema_version = 41, applied"
6. [ ] Lancer seedBootstrap :
       `ssh root@178.104.108.108 'cd /root/satrank && docker compose run --rm api npm run seed:bootstrap'`
       → attendre `depositTiersInserted=5` (DB fraîche) ou `=0, existing=5` (déjà seedée)
7. [ ] Restart container : `docker compose up -d api --force-recreate`
8. [ ] Attendre readiness : `curl -sS https://satrank.dev/api/health` → 200 OK

**Note — SKIP ETL assumé** : aucune restauration d'agents/transactions/probes
depuis le dump SQLite. La Postgres démarre vide (hors `deposit_tiers` seedés).
Le crawler Observer Protocol + lndGraphCrawler repeuplera `agents` /
`transactions` / `service_endpoints` dans les heures qui suivent. Ce choix est
**explicite** (décision pré-B5) : éviter un ETL risky sur table centrale avant
validation prod du pool pg. Le snapshot SQLite §1.3 reste la source de vérité
si rollback.

---

## 3. Smoke tests post-cut-over (endpoints corrigés)

Les endpoints `/api/decide` et `/api/best-route` sont **410 Gone** depuis Phase 10
(`createGoneHandler` dans `src/routes/v2.ts`). Remplacés par :

### 3.1 `POST /api/intent` — NL discovery (actif)

- [ ] ```
      curl -sS -X POST https://satrank.dev/api/intent \
        -H 'Content-Type: application/json' \
        -d '{"query":"send 1000 sats to a high-trust lightning address"}' | jq .
      ```
- [ ] Attendu : `200 OK`, champ `suggestions` non vide, `meta.intentKind` résolu.

### 3.2 `POST /api/probe` — doit répondre `402 Payment Required` sans token

- [ ] ```
      curl -sS -i -X POST https://satrank.dev/api/probe \
        -H 'Content-Type: application/json' \
        -d '{"url":"https://example.l402/test"}'
      ```
- [ ] Attendu : **`HTTP/1.1 402 Payment Required`** avec header `WWW-Authenticate: L402 …`
      (comportement normal — L402 gate Aperture actif).

### 3.3 `GET /api/agents/top?limit=10`

- [ ] ```
      curl -sS 'https://satrank.dev/api/agents/top?limit=10' | jq '.data | length'
      ```
- [ ] Attendu : `10` (ou nombre d'agents si < 10). Champ `data` est un array trié par score desc.

### 3.4 `GET /api/health`

- [ ] ```
      curl -sS https://satrank.dev/api/health | jq .
      ```
- [ ] **Obligatoire (hard gate)** : `dbStatus=ok`, `schemaVersion=41`, `lndStatus=ok`
- [ ] **Toléré transitoirement** : `scoringStale=true` et donc `status=error`.
      Post-cut la Postgres est vide (SKIP ETL assumé §2), le scoring n'a pas
      de données pour recalibrer tant que le crawler n'a pas repeuplé.
      → `status=error` NE BLOQUE PAS la validation B5 si les 3 obligatoires
      ci-dessus sont verts.
- [ ] **Gate recovery T+24h** : à 24h post-cut, relancer
      `curl -sS https://satrank.dev/api/health` et vérifier
      `scoringStale=false`. Si encore `true` à T+24h → crawler ne repeuple
      pas correctement, investiguer (cf. `docs/phase-12c/OPS-ISSUES.md`).

---

## 4. **Règle cardinale LND — vérification non-négociable**

**STOP immédiat et ping utilisateur si l'un des checks suivants échoue ou retourne
un état inattendu.** La migration Postgres ne doit pas avoir affecté indirectement
LND (saturation CPU/RAM pendant le switch, pression disque pg sur volume partagé,
etc).

### 4.1 LND actif

- [ ] ```
      ssh root@178.104.108.108 'lncli getinfo'
      ```
- [ ] Attendu : `synced_to_chain: true`, `synced_to_graph: true`, `num_active_channels >= 3`,
      `block_height` cohérent avec timestamp courant, pas d'alerte.

### 4.2 Canaux actifs

- [ ] ```
      ssh root@178.104.108.108 'lncli listchannels --active_only' | jq '.channels | length'
      ```
- [ ] Attendu : **≥ 3 canaux actifs** (Kraken, Babylon-4a, ACINQ), balances inchangées
      vs état pré-cut-over (tolérance 0 — aucune transaction routée pendant la fenêtre).
- [ ] Snapshot balance pré-cut-over à capturer **avant** la section 2 :
      ```
      ssh root@178.104.108.108 'lncli listchannels --active_only' \
        | jq '.channels | map({remote_pubkey, local_balance, remote_balance})' \
        > /tmp/channels-pre-cutover.json
      ```
      Puis comparer post-cut-over avec même commande et `diff`.

### 4.3 Si anomalie LND

- Ne pas relancer, ne pas patcher automatiquement.
- Ping utilisateur immédiatement avec :
  - stderr/stdout complet de `lncli getinfo` et `listchannels`
  - état du container satrank-api (`docker ps`, `docker logs api --tail 200`)
  - état mémoire/CPU (`free -h`, `top -b -n1 | head -20`)
- Préparer rollback SQLite (section 1.4) mais **ne pas exécuter** sans GO.

---

## 5. Validation B5 complete

B5 est **complet uniquement si** :

- [ ] Sections 1 à 4 toutes cochées sans anomalie
- [ ] LND : getinfo + listchannels identiques pré/post (§4)
- [ ] Smoke tests §3.1–3.4 tous verts
- [ ] `/api/health` retourne `schemaVersion: 41` + `db.connected: true`
- [ ] Logs `satrank-api` sans erreur PG (pas de `connection refused`, pas de
      `relation … does not exist`, pas de `too many clients`)
- [ ] Monitoring 15 min post-cut : pas de 5xx spike, pas de latence p95 > 2× baseline

**Si tous verts** : commit anchor B5, passer à B6 (quick wins) puis B7+ selon backlog.

**Si un seul rouge** : rollback SQLite (section 1.4), ping utilisateur, post-mortem
en `docs/phase-12b/B5-POSTMORTEM.md`.

---

## 6. Autorisations requises

- [ ] **GO utilisateur pour §2 (cut-over)** — ne rien lancer avant
- [ ] **GO utilisateur pour §1.4 rollback** si activé (modification prod state majeure)
- [ ] Pas d'opération LND (openchannel, closechannel, rebalance) en dehors des
      `getinfo` / `listchannels --active_only` listés en §4 (règle cardinale
      absolue, aucune exception)
