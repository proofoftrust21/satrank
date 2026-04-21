# Phase 12B — Seed bootstrap notes

**Required by:** B4 simplified (no ETL — crawler rebuilds observational data).

**Date:** 2026-04-21

## Goal

Document what can be seeded deterministically on a fresh Postgres (idempotent,
re-runnable) and what is crawler- or user-derived (rebuilt over 3-4 days of
crawler runs post cut-over).

## Seeded by `src/scripts/seedBootstrap.ts`

Run once after `runMigrations()` on a fresh database. Every INSERT uses
`ON CONFLICT DO NOTHING`, so re-runs are harmless.

| Table           | Rows | Source                                      |
|-----------------|------|---------------------------------------------|
| `deposit_tiers` | 5    | Phase 9 v39 fixed schedule (immutable)      |

Values (from `src/tests/depositTiersMigration.test.ts`):

```
min_deposit_sats | rate_sats_per_request | discount_pct
21               | 1.0                   | 0
1000             | 0.5                   | 50
10000            | 0.2                   | 80
100000           | 0.1                   | 90
1000000          | 0.05                  | 95
```

Changing any of these would break L402 tokens already issued against the old
rate — the rate is engraved on `token_balance` at INSERT time.

## NOT seeded (crawler-derived — will rebuild post cut-over)

| Table                       | Source                                               |
|-----------------------------|------------------------------------------------------|
| `agents`                    | `src/crawler/lndGraphCrawler.ts` (LND describegraph) |
| `transactions`              | Observer protocol + probe crawler + user reports     |
| `probe_results`             | `src/crawler/probeCrawler.ts`                        |
| `score_snapshots`           | Scoring batch on top of observational data           |
| `channel_snapshots`         | LND crawler (time-series)                            |
| `fee_snapshots`             | LND crawler (time-series)                            |
| `streaming_posteriors`      | Bayesian update on top of transactions/probes        |
| `daily_buckets_*`           | Aggregation on top of observational data             |
| `service_endpoints`         | Registry crawler (402index + L402Apps)               |
| `operators`                 | `src/scripts/inferOperatorsFromExistingData.ts`      |
|                             | runs against rebuilt `transactions` + `agents`       |
| `operator_identities`       | User registrations (NIP-98)                          |
| `operator_ownerships`       | Inferred from registered identities                  |
| `attestations`              | User `POST /api/attestation` submissions             |
| `report_bonus_ledger`       | Emitted when a reporter's report reaches threshold   |

## NOT seeded (intentionally empty until first user)

| Table              | Populated by                                         |
|--------------------|------------------------------------------------------|
| `token_balance`    | `POST /api/deposit` (user pays invoice)              |
| `token_query_log`  | `balanceAuth` middleware (one row per decide/report) |
| `preimage_pool`    | Self-registration endpoint verifies invoice preimage |
| `nostr_published_events` | Nostr publisher logs                           |

## NOT seeded (in-code constants, no DB row)

- `categories` — validated by `src/utils/categoryValidation.ts` CATEGORY_WHITELIST.
- Scoring weights / thresholds — in `src/config/scoring.ts` and `src/config.ts`.
- Wallet providers — `src/config/walletProviders.ts`.

## Cut-over sequence (B5)

1. Postgres already at schema v41 (apply `postgres-schema.sql` if missing).
2. Run `npm run seed:bootstrap` → populates `deposit_tiers` (5 rows).
3. API answers immediately (service_endpoints empty → discovery returns []).
4. Crawler starts on the dedicated pool, reconstruction begins:
   - t+0     : LND graph crawl → agents, channel_snapshots, fee_snapshots.
   - t+hours : probe crawler → probe_results, transactions (source='active_probe').
   - t+1d    : registry crawler → service_endpoints (94+ indexed).
   - t+3-4d  : scoring converges; operator inference can be re-run; posteriors stabilise.
5. Rollback contingency: DNS cutback to the old SQLite pod (still live until B5+48h).
