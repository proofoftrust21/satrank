# Phase 14D.3.0 — Aperture sunset cutover checklist

**Cible** : retrait Aperture (L402 reverse proxy :8082) au profit du middleware L402 natif Express (`src/middleware/l402Native.ts`).

**VM** : `178.104.108.108` (root@satrank).
**Repo local** : `/Users/lochju/satrank`.
**Downtime attendu** : ~8-15 secondes (docker compose `--force-recreate api`).
**Rollback window** : immédiat via `scripts/rollback-l402-native.sh <BACKUP_DIR>`.

---

## Pré-cutover (machine opérateur)

1. **Vérifier les livrables étape 5** :
   - [ ] `scripts/cutover-l402-native.sh` présent, exécutable
   - [ ] `scripts/rollback-l402-native.sh` présent, exécutable
   - [ ] `infra/nginx/satrank.conf.l402-native` à jour
   - [ ] `/tmp/.env.production.new` drafté localement (chmod 600)
   - [ ] `/tmp/satrank-nginx.new` drafté localement (copie de `satrank.conf.l402-native`)
   - [ ] Secrets recopiés dans `/tmp/l402-prod-secrets-20260423.txt` (chmod 600)

2. **GO/NOGO final** avant scp :
   - [ ] Tests verts (18/18 intégration, suite entière, lint OK)
   - [ ] LND healthy (side-check rapide : `ssh root@178.104.108.108 'lncli getinfo | jq .synced_to_chain'` → `true`)
   - [ ] bitcoind healthy (`ssh ... 'bitcoin-cli getblockchaininfo | jq .verificationprogress'` → `1`)
   - [ ] Aperture encore actif — on ne touche à rien tant que GO n'est pas donné
   - [ ] Pas d'autre phase en cours

---

## Étape A — Staging des 2 fichiers sur la VM

```bash
# Depuis machine opérateur, SANS passer par /root/satrank (drift policy)
scp /tmp/.env.production.new   root@178.104.108.108:/tmp/.env.production.new
scp /tmp/satrank-nginx.new      root@178.104.108.108:/tmp/satrank-nginx.new

# Vérifier permissions distant
ssh root@178.104.108.108 'ls -la /tmp/.env.production.new /tmp/satrank-nginx.new'
ssh root@178.104.108.108 'chmod 600 /tmp/.env.production.new && chmod 644 /tmp/satrank-nginx.new'
```

**GO/NOGO A** : les 2 fichiers sont présents sur la VM, pas de typo dans le nom.

---

## Étape B — Push du code sur la VM (`make deploy`)

Le middleware `l402Native.ts`, la branche `OPERATOR_BYPASS_SECRET` dans `config.ts`, et le wiring `app.ts` doivent être déployés **avant** le cutover env.

```bash
# Depuis /Users/lochju/satrank
make deploy   # respecte .rsync-exclude, ne touche pas à .env.production
```

**Pas de `--force-recreate` à cette étape** : l'api qui tourne reste sur l'ancienne `.env.production` (Aperture encore actif), donc `featureFlags.l402Native = false` tant que `L402_MACAROON_SECRET` n'est pas dans l'env → comportement inchangé. Le nouveau code dort jusqu'au cutover env.

**GO/NOGO B** : `make deploy` OK, rsync sans erreur.

---

## Étape C — Lancer `scripts/cutover-l402-native.sh` sur la VM

```bash
ssh root@178.104.108.108
cd /root/satrank
sudo bash scripts/cutover-l402-native.sh
```

Le script va :

1. **Preflight** : vérifier que `/tmp/.env.production.new` et `/tmp/satrank-nginx.new` existent, que `L402_MACAROON_SECRET`, `OPERATOR_BYPASS_SECRET`, `LND_INVOICE_MACAROON_PATH` sont bien présents dans le staged env. Affiche les noms de variables (valeurs masquées).
2. **GO/NOGO C1** : `proceed with cutover? [y/N]` — taper `y` pour continuer.
3. **Snapshot** : `/root/aperture-sunset-backup-${TIMESTAMP}/` avec `env-production.bak`, `nginx-satrank.bak`, `aperture.db.backup`, `docker-images-pre.txt`, `aperture-status-pre.txt`. ⚠ **noter le BACKUP_DIR** — nécessaire pour rollback.
4. **Stop Aperture** : `systemctl stop aperture && systemctl disable aperture`.
5. **Swap env** : `cp /tmp/.env.production.new /root/satrank/.env.production` (chmod 600, root:root).
6. **Swap nginx** : `cp /tmp/satrank-nginx.new /etc/nginx/sites-enabled/satrank && nginx -t`. Si `nginx -t` échoue, restaure l'ancien nginx et redémarre Aperture (abort sans downtime api).
7. **Rebuild + recreate api+crawler** : `docker compose build api crawler && docker compose up -d --force-recreate api crawler`.
8. **Wait healthy** : boucle 60× 3s = 180s max. Si `unhealthy` → dump logs + abort.
9. **Reload nginx** : `systemctl reload nginx`.
10. **Smoke checks** : `curl /api/health` (200), `curl /api/agent/<zero-hash>` (402 + `WWW-Authenticate: L402`), `curl POST /api/probe` (402 + L402 + invoice `lnbc`).

**GO/NOGO C2** : smoke checks OK. Si l'un des 3 smoke retourne autre chose que 402 (ou 200 pour health), **STOP et rollback**.

---

## Étape D — Tests end-to-end manuels (hors script)

À exécuter depuis la machine opérateur (pas depuis la VM), pour valider l'ingress public :

```bash
# 1. Health
curl -i https://satrank.dev/api/health

# 2. 402 challenge sur /api/agent
curl -i https://satrank.dev/api/agent/0000000000000000000000000000000000000000000000000000000000000000

# 3. Vérifier WWW-Authenticate: L402 macaroon="...", invoice="lnbc10n..."
#    Extraire l'invoice BOLT11.

# 4. Payer l'invoice via Wallet of Satoshi (depuis phone)
#    Récupérer le preimage (64 hex).

# 5. Retry avec Authorization: L402 <macaroon>:<preimage>
curl -i -H "Authorization: L402 <MAC>:<PREIMAGE>" \
    https://satrank.dev/api/agent/0000000000000000000000000000000000000000000000000000000000000000
# Attendu : HTTP 200 + payload agent.

# 6. Operator bypass (depuis machine opérateur)
curl -i -H "X-Operator-Token: 4d8cb96b...2ed33727" \
    https://satrank.dev/api/agent/0000000000000000000000000000000000000000000000000000000000000000
# Attendu : HTTP 200 + payload agent (passe-plat).

# 7. Deposit bypass (si balance > 0)
curl -i -H "Authorization: L402 deposit:<preimage-deposit>" \
    https://satrank.dev/api/agent/<hash>
# Attendu : HTTP 200 (balanceAuth débite 1 crédit).
```

**GO/NOGO D** : les 6 cas passent comme attendu. Si un cas renvoie 500 ou une erreur L402 inattendue, inspecter `docker logs satrank-api --tail 100` avant rollback.

---

## Étape E — Observations post-cutover (J+0 à J+24h)

- [ ] `docker logs satrank-api` : pas de `Invalid configuration` au boot
- [ ] `docker logs satrank-api | grep -i l402` : 402 challenges émis + paiements settle au prorata des visites
- [ ] `/api/health` reste 200 (pas de degraded feature inattendue)
- [ ] `systemctl status aperture` reste `inactive (dead)` + `disabled` (pas de redémarrage auto)
- [ ] `ss -lntp | grep 8082` : aucun process en écoute
- [ ] Pas de regression sur crawler, Nostr publish, intent-fulfill flow (bytes in/out monitoring)

---

## Rollback — si quoi que ce soit tourne mal

**Trigger** : smoke check échoue, api unhealthy > 180s, 5xx sustained en prod, user complaint.

```bash
ssh root@178.104.108.108
cd /root/satrank
sudo bash scripts/rollback-l402-native.sh /root/aperture-sunset-backup-${TIMESTAMP}
```

Le script restore :
1. `.env.production` pré-cutover (APERTURE_SHARED_SECRET intact, pas de L402_MACAROON_SECRET → `featureFlags.l402Native = false` → `apertureGateAuth` reprend la main)
2. nginx config pré-cutover (`map $paid_backend` réactive Aperture :8082)
3. `systemctl enable + start aperture`
4. `docker compose up -d --force-recreate api crawler` avec l'ancien env
5. `systemctl reload nginx`
6. Smoke : 402 via Aperture attendu

**Durée rollback** : ~30-45 secondes.

---

## Étape 8 (hors-scope cutover, planifiée J+7)

Une fois la nouvelle implémentation stable pendant 7 jours :
- Retirer `APERTURE_SHARED_SECRET` de `config.ts` (ligne 221-224 du boot guard + schema optional)
- Retirer la branche `X-Aperture-Token` de `src/middleware/auth.ts`
- Retirer `apertureGateAuth` entièrement (remplacé par `l402Native` depuis 7 jours)
- Retirer l'ancien nginx config `infra/nginx/satrank.conf` (garder seulement `satrank.conf.l402-native` renommé en `satrank.conf`)
- Désinstaller le binaire Aperture + purger `/root/.aperture/`

Pas dans ce PR. Attendre Romain GO.
