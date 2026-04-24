# Phase 12B — Crawler race-condition audit

**Required by:** B0 decision **B** — identify check-then-insert and read-modify-write
patterns; wrap in `withTransaction()` with `SELECT FOR UPDATE` where needed.

**Date:** 2026-04-21
**Scope:** `src/crawler/**/*.ts`, `src/services/**/*.ts`, `src/middleware/balanceAuth.ts`

## Context

SQLite had a single-writer lock — all writes serialized by the WAL. Under
Postgres, multiple workers (API requests, crawler loops, scoring batches) can
hit the same row concurrently. Two classes of bug that SQLite hid:

1. **Check-then-insert (TOCTOU)** — `SELECT WHERE x = ?` then `INSERT` if not found.
   Concurrent callers both miss the check, both INSERT, one fails the unique
   constraint (best case) or both succeed if no constraint exists (worst case).
2. **Read-modify-write (RMW)** — `SELECT current`, compute `new = f(current)`,
   `UPDATE SET col = new`. Two concurrent callers overwrite each other.

Safe fixes:
- **ON CONFLICT** — atomic UPSERT in a single statement.
- **Arithmetic UPDATE** — `UPDATE t SET c = c + 1 WHERE id = $1`. Row-level lock
  already held by the `UPDATE`.
- **Explicit transaction** — `withTransaction(pool, async (client) => { client.query('SELECT ... FOR UPDATE'); ... })`.

---

## HIGH risk (ledger / balance / correctness)

| # | File:lines | Pattern | Fix |
|---|---|---|---|
| H1 | `src/crawler/crawler.ts:207-240` — `ensureAgent()` | `findByHash()` → if not found → `insert()` | `INSERT ... ON CONFLICT (public_key_hash) DO NOTHING` then `SELECT` |
| H2 | `src/crawler/lndGraphCrawler.ts:241-281` — `indexNode()` | `findByHash()` → `insert()` | Same as H1 |
| H3 | `src/crawler/mempoolCrawler.ts:70-133` — `indexNode()` | `findByHash()` → `insert()` | Same as H1 |
| H4 | `src/middleware/balanceAuth.ts:115` — token debit | `UPDATE token_balance SET remaining = remaining - 1 WHERE payment_hash = $1 AND remaining > 0` | Already guarded by `WHERE remaining > 0`. Under Postgres, row-level lock during UPDATE makes this atomic. **SAFE if we trust the rowcount check** (call site must verify `rowCount === 1` and reject the request otherwise). If we ever want stricter invariants, switch to `withTransaction` + `SELECT ... FOR UPDATE`. |

## MEDIUM risk (non-critical counters / metadata consolidation)

| # | File:lines | Pattern | Fix |
|---|---|---|---|
| M1 | `src/crawler/registryCrawler.ts:82-93` — `upsert()` conditional branch | `findByUrl()` → if exists → update, else → insert | Outer `INSERT ... ON CONFLICT DO UPDATE` handles it atomically; just remove the conditional `findByUrl()` pre-check |
| M2 | `src/crawler/lndGraphCrawler.ts:274-279` + `mempoolCrawler.ts:102-107` — alias consolidation | `findByExactAlias()` → `updatePublicKey()` | Idempotent (both threads write same pubkey); wrap in `withTransaction` only if strict ordering needed (not required) |
| M3 | `src/repositories/reportBonusRepository.ts:36-45` — `incrementEligibleCount()` | UPSERT `eligible_count + 1` plus pre/post SELECT | Already atomic via ON CONFLICT DO UPDATE; the outer `reportBonusService.maybeCredit()` transaction guarantees the read-your-write semantics |

## LOW risk (idempotent by design)

| # | File:lines | Pattern | Note |
|---|---|---|---|
| L1 | `src/repositories/agentRepository.ts:291,307` — `incrementQueryCount()`, `incrementTotalTransactions()` | `UPDATE agents SET col = col + 1 WHERE ...` | Safe — single-statement arithmetic UPDATE |
| L2 | `src/repositories/preimagePoolRepository.ts:34-43` — `insertIfAbsent()` | `INSERT OR IGNORE` (→ `ON CONFLICT DO NOTHING` on PG) | Safe — atomic by design |
| L3 | `src/repositories/preimagePoolRepository.ts:58-67` — `consumeAtomic()` | `UPDATE SET consumed_at = ? WHERE consumed_at IS NULL` | Safe — WHERE clause serves as the lock predicate; only one UPDATE succeeds |
| L4 | `src/repositories/serviceEndpointRepository.ts:58-92` — `upsert()` | `INSERT ... ON CONFLICT (url) DO UPDATE` with source-hierarchy check inside SQL | Safe — atomic UPSERT |
| L5 | `src/crawler/probeCrawler.ts:109-147` — probe result insertion | Direct `probeRepo.insert()`, append-only | Safe — append-only; duplicates across timestamps are expected sampling noise |
| L6 | `src/crawler/lndGraphCrawler.ts:108-157` — snapshot/PR batch writes | `db.transaction((entries) => ...)` | Safe — time-series append and PageRank overwrite are both idempotent |

## Already safe (explicit `db.transaction(...)()` wrapping)

These sites already use the better-sqlite3 transaction helper; the port just renames
`db.transaction(fn)()` → `await withTransaction(pool, async (client) => fn(client))`.

| File:lines | Function |
|---|---|
| `src/services/reportBonusService.ts:181-199` | `maybeCredit()` — ledger + balance credit |
| `src/services/attestationService.ts:95` | `submit()` — attestation + agent stats |
| `src/services/reportService.ts:244-245, 421` | `submit()`, `submitAnonymous()` |
| `src/crawler/probeCrawler.ts:217-249` | `ingestProbeToBayesian()` — dedup-by-txId + streaming ingest |
| `src/repositories/agentRepository.ts:249-256` | `updatePageRankBatch()` |
| `src/services/scoringService.ts:270-278` | `computeScore()` — stat rollup |

---

## Migration checklist (files needing care during the port)

1. **`src/crawler/crawler.ts`** — `ensureAgent()`: switch to `INSERT ... ON CONFLICT DO NOTHING` + `SELECT`, or wrap in `withTransaction` with `SELECT FOR UPDATE`.
2. **`src/crawler/lndGraphCrawler.ts`** — same for `indexNode()`.
3. **`src/crawler/mempoolCrawler.ts`** — same for `indexNode()`.
4. **`src/crawler/registryCrawler.ts`** — drop pre-`findByUrl()` check (UPSERT handles it).
5. **`src/middleware/balanceAuth.ts`** — verify caller checks `rowCount === 1` on debit; otherwise add `FOR UPDATE` inside `withTransaction`.
6. **`src/services/reportBonusService.ts`** — rename `db.transaction(...)()` → `await withTransaction(pool, async (client) => ...)`. Propagate `client` parameter into repository methods.
7. **`src/services/attestationService.ts`** — same rename.
8. **`src/services/reportService.ts`** — same rename (two call sites).
9. **`src/crawler/probeCrawler.ts`** — same rename.
10. **`src/repositories/agentRepository.ts`** — `updatePageRankBatch()`: same rename.

No additional SELECT FOR UPDATE needed beyond what the transaction rename covers —
Postgres UPDATE acquires a row-level exclusive lock, which is sufficient for the
arithmetic-UPDATE sites (L1) and the guard-clause UPDATEs (H4, L3).

## Invariants preserved post-port

- Agents table: public_key_hash is PRIMARY KEY → duplicate inserts raise
  `unique_violation (23505)` caught by ON CONFLICT.
- token_balance: debit guarded by `WHERE remaining > 0`; zero-debit rejected
  at the rowcount check in the middleware.
- preimage_pool: `UPDATE SET consumed_at = $1 WHERE payment_hash = $2 AND consumed_at IS NULL`
  → at most one thread gets `rowCount === 1`.
- report_bonus_ledger: `idempotency_key` UNIQUE → duplicate credits rejected at insert.
- service_endpoints: `ON CONFLICT (url) DO UPDATE` is atomic; source-hierarchy logic runs inside SQL.

## Out of scope for Phase 12B

- Fully replacing arithmetic-UPDATE counters with advisory locks or `INCR`-style
  primitives → Phase 12C if contention shows up in pg_stat_statements.
- Adding `SELECT ... FOR UPDATE SKIP LOCKED` to probe crawler worker queues —
  current fan-out is single-loop, no queue contention.
