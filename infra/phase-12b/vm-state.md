# Phase 12B — VM state

## satrank-postgres (B1, 2026-04-21)

| Field | Value |
|---|---|
| Hetzner ID | 127633334 |
| Name | satrank-postgres |
| Type | cpx42 (8 vCPU / 16 GB / 320 GB) |
| Location | nbg1 (same DC as prod SatRank) |
| Image | debian-12 |
| IPv4 | 178.104.142.150 |
| IPv6 | 2a01:4f8:1c18:2d5d::1 |
| SSH key | macbook (ID 110102224) |
| Created | 2026-04-21 14:12 CEST |

## Stack after B1

- Docker 29.4.1 (active, enabled)
- UFW active (only 22/tcp open)
- fail2ban active (sshd jail, systemd backend, bantime 1h / maxretry 5)
- Disk free: 286 GB
- Memory free: 14 GB

## SSH

```
ssh -i ~/.ssh/id_ed25519 root@178.104.142.150
```

## Next steps

- ~~**B2** — Postgres 16 container + tuning~~ — done (see section below)
- **B3** — migrate schema + code SatRank (API pool=30, crawler pool=20)
- **B4** — ETL script from prod SQLite
- **STOP before B5** — pre-cut-over checklist review

## B2 — Postgres 16 (2026-04-21)

Running : `postgres:16` container (16.13), healthy, volume `postgres_pgdata`.

| Setting | Value |
|---|---|
| shared_buffers | 4 GB |
| effective_cache_size | 12 GB |
| work_mem | 64 MB |
| maintenance_work_mem | 1 GB |
| max_connections | 200 |
| random_page_cost | 1.1 |
| effective_io_concurrency | 200 |
| statement_timeout | 15 s |
| lock_timeout | 5 s |
| idle_in_transaction_session_timeout | 60 s |
| max_parallel_workers | 8 |
| max_wal_size | 4 GB |
| shared_preload_libraries | `pg_stat_statements` |

Extensions : `plpgsql 1.0`, `pg_stat_statements 1.10`.

UFW : 5432/tcp ALLOW from `178.104.108.108` only (prod SatRank API origin).

Connection string (from prod) :
```
postgresql://satrank:<pg_password>@178.104.142.150:5432/satrank
```
Password in `infra/phase-12b/secrets/pg_password` (gitignored, file mode 600).
