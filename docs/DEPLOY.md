# Deploy procedure

## Canonical workspace

Production workspace on the VM: `/root/satrank/`.

- Source of truth: `git fetch origin main && git reset --hard origin/main` keeps
  it aligned with `main`.
- Docker builds and runs from this directory:
  `docker compose build && docker compose up -d --force-recreate`.
- Secrets (`.env.production`, `*.macaroon`) are not in git, are preserved across
  rsync deploys via `.rsync-exclude`, and must be rotated manually when needed.
- The legacy `/opt/satrank/` workspace is archived under
  `/opt/satrank-archived-YYYYMMDD/`. It will be removed after 7 days of stable
  observation.

---

## Mechanical rule

**Every deploy must go through `make deploy`.** Never an ad-hoc rsync against
prod. Exclusions are centralized in `.rsync-exclude` (see repo root) and the
Makefile refuses to deploy if that file is missing.

### Incident history

| Date       | Phase    | Erased file                | Root cause                                                         |
|------------|----------|----------------------------|--------------------------------------------------------------------|
| 2026-04-19 | Phase 7  | `.env.production`          | Ad-hoc `rsync --delete`, exclusion forgotten                       |
| 2026-04-20 | Phase 9  | `probe-pay.macaroon`       | Ad-hoc `rsync --delete`, exclusion forgotten                       |

Both incidents are the **same procedural fault**: bypassing `make deploy` for a
manual rsync. This page is the written rule that makes that bypass illegal.

---

## Files that MUST NEVER be erased by rsync in prod

These files live only on prod, are not in the repo, and would be catastrophic
to lose:

### Secrets
- `.env.production` — prod env variables (API keys, DB secrets, LND config)
- `.env`, `.env.local`, `.env.*.local`

### LND credentials (macaroons)
- `probe-pay.macaroon` — scoped admin for `/api/probe` (offchain:read+write)
- `admin.macaroon` — full admin (if mounted)
- `invoice.macaroon` — for `/api/deposit` (invoice-only)
- `readonly.macaroon` — for the LND crawler
- Global rule: `*.macaroon` at any depth

### L402 Config
- Express serves the L402 gate natively since Phase 14D.3.0 (middleware `src/middleware/l402Native.ts`). No proxy config file to exclude.
- The `aperture.yaml` and `aperture.local.yaml` entries in `.rsync-exclude` remain as defense-in-depth. They will be removed during the final post-sunset code cleanup (planned 2026-04-30, after 7 days of stable prod observation).

### Runtime state
- `data/` — SQLite directory (holds `satrank.db`, `satrank.db-wal`, etc.)
- `*.db`, `*.sqlite`, `*.sqlite-journal`, `*.sqlite-shm`, `*.sqlite-wal`
- `backups/` — DB snapshots

### Logs (outside app dir, documented for info)
- `/var/log/satrank/` — lives on the host, never inside the rsynced project
  directory. If an operator thinks about rsyncing `/var/`, they should not.

---

## Deploy procedure

```bash
# From the local repo, clean commit state:
git status                      # must be clean (except build-info.json)
git push origin main

# Deploy:
SATRANK_HOST=root@178.104.108.108 REMOTE_DIR=/opt/satrank make deploy

# Rebuild + restart container:
ssh root@178.104.108.108 'cd /opt/satrank && docker compose build api && docker compose up -d --force-recreate api'

# For the crawler when dependencies are non-blocking:
ssh root@178.104.108.108 'cd /opt/satrank && docker compose up -d --no-deps crawler'
```

The Makefile passes `--exclude-from=.rsync-exclude` automatically. No manual
exclude flag is required.

---

## Prohibitions

1. **NEVER run**:
   ```bash
   rsync -az --delete ./ root@prod:/opt/satrank/
   ```
   Even with inline `--exclude` flags. Inline exclusions drift from the
   canonical list and eventually forget a critical file.

2. **NEVER run**:
   ```bash
   rsync -az --delete / root@prod:/       # obvious but worth restating
   ```

3. **Do not modify `.rsync-exclude` without PR and review.** Any entry added
   is a commitment to preserve it on prod.

---

## If the rule is violated (recovery)

### `.env.production` erased
- Restore from operator backup (do not ask me).
- Otherwise: reconstruct from known variables. Downtime risk.

### Macaroon erased
- Re-bake from LND:
  ```bash
  ssh root@178.104.108.108 'rmdir /opt/satrank/probe-pay.macaroon 2>/dev/null; \
    lncli --lnddir=/mnt/lnd-data/lnd --network=mainnet bakemacaroon \
    offchain:read offchain:write \
    --save_to=/opt/satrank/probe-pay.macaroon'
  ```
- LND macaroons are **not reversible** — baking regenerates a new one, no
  need to restore the original.

### `data/satrank.db` erased
- Restore from backup (daily cron — see `make backup`).
- Data loss between the last backup and the incident. No partial rollback
  possible (no replication).

---

## References

- `.rsync-exclude` — canonical exclusion list
- `Makefile` — `deploy` target
- `feedback_rsync_delete_env.md` — Claude Code memory of the Phase 7 incident
- `feedback_safety_rules.md` — global SatRank safety rules
