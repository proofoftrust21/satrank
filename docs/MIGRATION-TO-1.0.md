# Migration guide: SatRank 0.x to 1.0

Phase 10 retires two legacy HTTP endpoints. This guide covers every
caller-visible change in 1.0 and the exact replacement call.

## TL;DR

| Before (0.x) | After (1.0) | Change |
|---|---|---|
| `POST /api/decide` | `POST /api/intent` | **410 Gone** (rewrite required) |
| `POST /api/best-route` | `GET /api/services/best` **or** `POST /api/intent` | **410 Gone** (rewrite required) |
| `GET /api/agent/:hash` | `GET /api/agent/:hash` | **No change** (camelCase preserved) |
| Table `decide_log` | Table `token_query_log` | Internal only; migration v41 runs automatically |

API version header `X-API-Version: 1.0` is unchanged; the header was
already 1.0 in 0.x.

## `/api/decide` → `/api/intent`

The old `/api/decide` returned a GO/NO-GO boolean with pathfinding and a
survival verdict. Callers were mixing three concerns:

1. **Neutral discovery**: "which service should I use for X?"
2. **Trust check**: "is this agent safe to transact with?"
3. **Personalized pathfinding**: "which hub gives me the best route?"

In 1.0, concern (1) lives on `/api/intent`, (2) on `/api/agent/:hash/verdict`,
and (3) on `/api/services/best`.

### Before

```bash
POST /api/decide
Authorization: L402 <token>:<preimage>
Content-Type: application/json

{
  "target": "<hash>",
  "caller": "<hash>",
  "amountSats": 1000
}
```

### After: discovery intent

```bash
POST /api/intent
Authorization: L402 <token>:<preimage>
Content-Type: application/json

{
  "intent": "summarize this URL",
  "caller": "<hash>",
  "walletProvider": "phoenix"
}
```

Response gives a ranked service list (best route, trust-weighted);
pick the top `service.url` and proceed.

### After: verdict check (if you already know the target)

```bash
GET /api/agent/<hash>/verdict
Authorization: L402 <token>:<preimage>
```

Returns `SAFE / RISKY / UNKNOWN` with risk profile.

## `/api/best-route` → `/api/services/best` or `/api/intent`

`/api/best-route` was a single-target 3D ranker (route quality + trust
+ http health). In 1.0:

- For a **known service URL**, call `GET /api/services/best?serviceUrl=...`
  (free discovery endpoint, rate-limited).
- For a **high-level user goal** ("I need an image API under 100 sats"),
  call `POST /api/intent`; it runs the same composite ranker and
  returns a ranked list.

### Before

```bash
POST /api/best-route
{ "target": "<hash>", "caller": "<hash>" }
```

### After

```bash
GET /api/services/best?serviceUrl=https://example.com/api
```

Response includes `routeQuality`, `trustScore`, `httpHealth`, and the
composite score used to rank.

## Database rename: `decide_log` → `token_query_log`

Runs automatically on server startup when upgrading to 1.0 (schema
v40 → v41). This table logs which targets a given L402 token has
queried, used by `/api/report` for scope-checking (a token can only
report on targets it has decided within the auth window).

If you have external tooling reading this table directly (unusual,
since it's an internal implementation detail), update the table name.

The v41 migration has a matching down migration if you need to roll
back to v40. No data is dropped.

## Response field casing

We audited all 1.0 response surfaces in C6. The summary:

- **camelCase preserved**: `/api/agent/:hash`, `/api/agent/:hash/verdict`,
  `/api/probe`, `/api/deposit/*`, `/api/intent`.
- **snake_case fields** (persisted, part of the contract, won't change
  in 1.x): `/operators`, `/endpoint/:url_hash`, stats endpoints for
  fields like `n_obs`, `p_success`, `verification_score`, `url_hash`,
  `lnp_rank`, `hubness_rank`.

If you're using the SDK (`@satrank/sdk`), you don't need to worry;
the SDK surface is camelCase throughout. The snake_case fields only
appear in raw HTTP responses.

## Deprecation timeline from here

- **1.0.x**: no breaking changes. `/api/decide` and `/api/best-route`
  stay 410 Gone. New features ship under minor bumps (1.1, 1.2, ...).
- **2.0 (TBD)**: reserved for the next round of contract changes.
  No timeline announced.

## Questions

File an issue at <https://github.com/proofoftrust21/satrank/issues> with
the tag `1.0-migration`.
