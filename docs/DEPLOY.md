# Deploy procedure

## Règle mécanique

**Tout déploiement doit passer par `make deploy`.** Jamais un rsync manuel contre
prod. Les exclusions sont centralisées dans `.rsync-exclude` (voir la racine du
repo) et la Makefile refuse de déployer si ce fichier est absent.

### Historique des incidents

| Date       | Phase    | Fichier effacé             | Cause racine                                                       |
|------------|----------|----------------------------|---------------------------------------------------------------------|
| 2026-04-19 | Phase 7  | `.env.production`          | `rsync --delete` ad-hoc, exclusion oubliée                          |
| 2026-04-20 | Phase 9  | `probe-pay.macaroon`       | `rsync --delete` ad-hoc, exclusion oubliée                          |

Les deux incidents sont la **même faute procédurale** : bypass de `make deploy`
pour un rsync manuel. Cette page est la règle écrite qui rend ça illégal.

---

## Fichiers qui NE DOIVENT JAMAIS être effacés par rsync en prod

Ces fichiers vivent uniquement sur prod, ne sont pas dans le repo, et seraient
catastrophiques à perdre :

### Secrets
- `.env.production` — variables d'env prod (clés API, secrets DB, config LND)
- `.env`, `.env.local`, `.env.*.local`

### Credentials LND (macaroons)
- `probe-pay.macaroon` — scoped admin pour `/api/probe` (offchain:read+write)
- `admin.macaroon` — admin complet (si monté)
- `invoice.macaroon` — pour `/api/deposit` (invoice-only)
- `readonly.macaroon` — pour le crawler LND
- Règle globale : `*.macaroon` à n'importe quelle profondeur

### Config L402
- `aperture.yaml` — config Aperture (reverse-proxy L402, référence des secrets)
- `aperture.local.yaml`

### Runtime state
- `data/` — dossier SQLite (contient `satrank.db`, `satrank.db-wal`, etc.)
- `*.db`, `*.sqlite`, `*.sqlite-journal`, `*.sqlite-shm`, `*.sqlite-wal`
- `backups/` — snapshots DB

### Logs (hors app dir, documenté pour info)
- `/var/log/satrank/` — vit sur l'hôte, jamais dans le dossier projet rsyncé.
  Si un opérateur pense à rsyncer `/var/`, il ne devrait pas.

---

## Procédure de deploy

```bash
# Depuis le repo local, commit propre :
git status                      # doit être clean (sauf build-info.json)
git push origin main

# Deploy :
SATRANK_HOST=root@178.104.108.108 REMOTE_DIR=/opt/satrank make deploy

# Rebuild + restart container :
ssh root@178.104.108.108 'cd /opt/satrank && docker compose build api && docker compose up -d --force-recreate api'

# Pour le crawler si dépendances non bloquantes :
ssh root@178.104.108.108 'cd /opt/satrank && docker compose up -d --no-deps crawler'
```

La Makefile passe `--exclude-from=.rsync-exclude` automatiquement. Aucun flag
d'exclusion manuel nécessaire.

---

## Interdictions

1. **Ne JAMAIS faire** :
   ```bash
   rsync -az --delete ./ root@prod:/opt/satrank/
   ```
   Même avec des `--exclude` inline. Les exclusions inline se désynchronisent
   de la liste canonique et finissent par oublier un fichier critique.

2. **Ne JAMAIS faire** :
   ```bash
   rsync -az --delete / root@prod:/       # évident mais à rappeler
   ```

3. **Ne pas modifier `.rsync-exclude` sans PR/review.** Toute entrée ajoutée
   est un engagement à la préserver en prod.

---

## Si la règle est violée (recovery)

### `.env.production` effacé
- Restaurer depuis backup opérateur (ne pas me demander).
- Sinon : reconstruire à partir des variables connues. Risque de downtime.

### Macaroon effacé
- Re-baker depuis LND :
  ```bash
  ssh root@178.104.108.108 'rmdir /opt/satrank/probe-pay.macaroon 2>/dev/null; \
    lncli --lnddir=/mnt/lnd-data/lnd --network=mainnet bakemacaroon \
    offchain:read offchain:write \
    --save_to=/opt/satrank/probe-pay.macaroon'
  ```
- Les macaroons LND ne sont **pas réversibles** — baker en régénère un
  nouveau, pas besoin de restaurer l'original.

### `data/satrank.db` effacée
- Restaurer depuis backup (cron journalier — voir `make backup`).
- Perte de données entre dernier backup et l'incident. Aucun rollback
  partiel possible (pas de réplication).

---

## Références

- `.rsync-exclude` — liste canonique des exclusions
- `Makefile` — cible `deploy`
- `feedback_rsync_delete_env.md` — mémoire Claude Code de l'incident Phase 7
- `feedback_safety_rules.md` — règles de sécurité SatRank globales
