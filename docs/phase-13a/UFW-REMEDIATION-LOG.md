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

### Pending user decision

Close HIGH finding requires **iptables DOCKER-USER** rules (outside UFW scope, different fix). Proposed commands:

```bash
iptables -I DOCKER-USER -p tcp --dport 5432 -s 178.104.108.108 -j ACCEPT
iptables -I DOCKER-USER -p tcp --dport 5432 -j DROP
ip6tables -I DOCKER-USER -p tcp --dport 5432 -j DROP
# Persist via iptables-save > /etc/iptables/rules.v4 (assumes iptables-persistent installed)
```

Effects:
- Pre-routes traffic for port 5432 before Docker's NAT → controllable by host firewall
- Zero impact on satrank-postgres container, no restart
- Reversible: `iptables -D DOCKER-USER -p tcp --dport 5432 -j DROP` etc.

**Not applied autonomously** — user brief specified UFW only, iptables DOCKER-USER is a deviation (different firewall layer). Ping user for GO.

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

- **Action 2 (chmod .env)**: ✅ closed
- **Action 3 (Dependabot)**: ✅ closed
- **Action 1 (UFW deny)**: ⚠️ rules applied, ineffective due to Docker bypass. HIGH finding remains open pending iptables DOCKER-USER decision.
