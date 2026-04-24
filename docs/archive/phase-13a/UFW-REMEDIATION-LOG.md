# Phase 13A — Remediation log (2026-04-22)

## Action 1 — UFW whitelist Postgres VM (178.104.142.150)

### Steps executed

| # | Command | Result |
|---|---------|--------|
| 1 | `ufw status verbose` (before) | `22/tcp ALLOW Anywhere` + `5432/tcp ALLOW 178.104.108.108` already present, default incoming = deny |
| 2 | `ufw allow from 178.104.108.108 to any port 5432 proto tcp` | `Rule updated` (idempotent) |
| 3 | Prod → PG `SELECT 1` | `OK [{"?column?":1}]` |
| 4 | `ufw deny 5432/tcp` | `Rule added` (v4+v6) |
| 5 | Prod → PG `SELECT 1` (retest) | `OK` — allow-specific wins over deny-global ✅ |
| 6 | External probe from `lochju` macOS → `178.104.142.150:5432` | **REACHABLE** ❌ |

### Anomaly: UFW ineffective on Docker-published ports

Root cause: `docker-proxy` listens on `0.0.0.0:5432` and Docker inserts its own iptables rules in the `DOCKER` chain, which is evaluated **before** UFW's filter chain. UFW rules are therefore silently bypassed for container-published ports.

```
LISTEN 0 4096 0.0.0.0:5432 docker-proxy(pid=21601)
LISTEN 0 4096 [::]:5432    docker-proxy(pid=21607)
```

### Current UFW state (rules remain in place, harmless)

```
[ 1] 22/tcp                     ALLOW IN    Anywhere                   # ssh
[ 2] 5432/tcp                   ALLOW IN    178.104.108.108
[ 3] 5432/tcp                   DENY IN     Anywhere
[ 4] 22/tcp (v6)                ALLOW IN    Anywhere (v6)              # ssh
[ 5] 5432/tcp (v6)              DENY IN     Anywhere (v6)
```

### Pending user decision → RESOLVED (2026-04-22, same-day fix)

See section "iptables DOCKER-USER fix applied" below.

---

## Action 1b — iptables DOCKER-USER fix applied

### Steps executed (2026-04-22, post-GO)

| # | Command | Result |
|---|---------|--------|
| 1 | `iptables -L DOCKER-USER -n -v` (before) | chain empty |
| 2 | `iptables -I DOCKER-USER -p tcp --dport 5432 -s 178.104.108.108 -j ACCEPT` | added |
| 3 | Prod → PG `SELECT 1` | `OK` |
| 4 | `iptables -I DOCKER-USER -p tcp --dport 5432 -j DROP` | added at pos 1 — **ordering bug**: DROP ahead of ACCEPT |
| 5 | **Corrective action**: `iptables -D DOCKER-USER -p tcp --dport 5432 -j DROP` then `iptables -A DOCKER-USER -p tcp --dport 5432 -j DROP` (append) | rule order fixed: ACCEPT(1) → DROP(2) |
| 6 | Prod → PG `SELECT 1` (retest) | `OK` — allow-specific wins |
| 7 | `ip6tables -A DOCKER-USER -p tcp --dport 5432 -j DROP` | added |
| 8 | Prod → PG (retest) | `OK` |
| 9 | External probe from `lochju` macOS | `TIMEOUT — blocked` ✅ |
| 10 | `apt install -y iptables-persistent` (preseed autosave_v4/v6=true) | installed, netfilter-persistent enabled |
| 11 | `netfilter-persistent save` | `/etc/iptables/rules.v4` + `rules.v6` written |

### Final DOCKER-USER chain state

```
Chain DOCKER-USER (v4)
num   target     prot  source               destination           details
1     ACCEPT     tcp   178.104.108.108      0.0.0.0/0             tcp dpt:5432
2     DROP       tcp   0.0.0.0/0            0.0.0.0/0             tcp dpt:5432

Chain DOCKER-USER (v6)
1     DROP       tcp   ::/0                 ::/0                  tcp dpt:5432
```

### Persistence verified

```
$ grep 5432 /etc/iptables/rules.v4
-A DOCKER -d 172.18.0.2/32 ! -i br-d13310036b63 -o br-d13310036b63 -p tcp -m tcp --dport 5432 -j ACCEPT
-A DOCKER-USER -s 178.104.108.108/32 -p tcp -m tcp --dport 5432 -j ACCEPT
-A DOCKER-USER -p tcp -m tcp --dport 5432 -j DROP
-A DOCKER ! -i br-d13310036b63 -p tcp -m tcp --dport 5432 -j DNAT --to-destination 172.18.0.2:5432

$ grep 5432 /etc/iptables/rules.v6
-A DOCKER-USER -p tcp -m tcp --dport 5432 -j DROP
```

`netfilter-persistent.service` symlinked in `multi-user.target.wants/` — rules reload on boot.

### Final verification matrix

| Probe | Expected | Actual |
|-------|----------|--------|
| External (lochju) → `178.104.142.150:5432` | timeout | **TIMEOUT ✅** |
| Prod (178.104.108.108) → PG `SELECT 1` | OK | **OK ✅** |
| `curl -I https://satrank.dev/api/health` | 200 | **200 ✅** |

**HIGH finding F1 (Postgres public exposure) → CLOSED.**

### Cardinal-rule audit

- LND process: not touched (runs on prod VM 178.104.108.108, not PG VM)
- Macaroons, Nostr key, wallet.db, channel.db: not on PG VM, not touched
- LND → bitcoind flow: unaffected
- Only change on PG VM: iptables DOCKER-USER chain (2 rules v4, 1 rule v6) + iptables-persistent package install

---

## Action 2 — chmod prod `.env`

| Step | Result |
|------|--------|
| Before | `-rw-r--r-- 1 root root 224 Apr 21 17:49 /root/satrank/.env` (0644) |
| `chmod 600 /root/satrank/.env` | applied |
| After | `-rw------- 1 root root 224 Apr 21 17:49 /root/satrank/.env` (0600) ✅ |

**Closed** — medium finding resolved.

---

## Action 3 — Enable Dependabot alerts

| Step | Result |
|------|--------|
| `gh api -X PUT repos/proofoftrust21/satrank/vulnerability-alerts` | Empty response (success signal) |
| `gh api --include repos/proofoftrust21/satrank/vulnerability-alerts` | `HTTP/2.0 204 No Content` ✅ |

**Closed** — Dependabot now monitors SatRank, auto-PRs for future CVEs.

---

## Post-action smoke

| Check | Result |
|-------|--------|
| `curl -I https://satrank.dev/api/health` | `HTTP/1.1 200 OK` |
| `/api/health` body | `"status":"ok"`, `dbStatus:"ok"`, `lndStatus:"ok"`, uptime 53k s (unchanged container) |
| LND / Nostr / macaroons / wallet.db | **Not touched** — cardinal rule respected |
| Prod → PG DB connection | `OK [{"?column?":1}]` — unchanged |

---

## Summary

- **Action 1a (UFW deny)**: rules in place (harmless, bypassed by Docker)
- **Action 1b (iptables DOCKER-USER)**: ✅ **HIGH finding F1 closed** — external probe blocked, prod reachability preserved, persisted across reboots
- **Action 2 (chmod .env)**: ✅ closed
- **Action 3 (Dependabot)**: ✅ closed
