# Restructure V2-Recentered — Changelog

Branch: `restructure/v2-recentered`
Started: 2026-05-08

## Vision

Per `/tmp/satrank-simplification-report.md` and the relecture critique adversarial appended within :

- Cible primaire confirmée = **agents consommateurs L402** zéro-friction
- Métrique J+60 = ≥ 100 paid `/api/intent` lookups/semaine × ≥ 5 pubkeys non-Romain
- Métrique défensive complémentaire = Gini ≤ 0.6 sur top-1 retournés (anti-bypass)
- Cibles taille : ~3 000 LOC, 8 tables, 5 endpoints HTTP, 3 outils MCP

## Commits

### 2df57e7 — slim public MCP server V2.0 (16 → 3 tools)

`src/mcp/server-public.ts` 521 → 269 LOC. Surface réduite à `intent`, `get_endpoint_score`, `verify_assertion`. Outils retirés du bundle public (toujours dans `src/mcp/server.ts` pour self-hosters) :

- `fulfill`, `fulfill_evidence` — ADJACENT post-relecture critique
- `mini_llm_classify`, `mini_llm_summarize`, `mini_llm_translate` — HORS-PARCOURS
- `aeps.daily_anchor`, `aeps.recent_anchors`, `aeps.inclusion_proof`, `aeps.evidence_receipt`, `aeps.get_dispute`, `aeps.list_forks`, `aeps.get_observations`, `aeps.get_multihop` — HORS-PARCOURS

### 6e9f6ad — feature flags V2 (default=true, no behavior change yet)

6 flags ajoutés à `src/config.ts` :
- `FULFILL_ENABLED`
- `CLAIM_ENGINE_ENABLED`
- `AGENT_BONDS_ENABLED`
- `AEPS_DISPUTE_ENABLED`
- `FORK_DETECTION_ENABLED`
- `MINI_LLM_ENABLED`

Defaults TRUE pour préserver le comportement actuel. Operator peut flip à FALSE via env. Câblage des checks `if (!config.X_ENABLED) return 503` dans les routes correspondantes deferré pour minimiser le diff par commit.

### fb788f1 — discovery_signal block dans /api/intent

Réponse à la critique adversariale Q3.d : la valeur du paid lookup doit être visible côté agent. Le block surface :
- `raw_catalog_matches` : total endpoints matching la catégorie
- `filtered_out` : compteurs par raison (V0 = bucket 'other' ; V1 future avec instrumentation repo)
- `returned_top_n` : post-rank+limit
- `estimated_sats_saved_vs_diy` : hint rough (filtered_count × 25)
- `explanation` : one-liner SDK-friendly

Optional — apparaît seulement quand ≥ 1 endpoint a été filtré. Backwards-compat avec SDKs ignorant le champ.

## What's NOT done in this branch (deferred)

Items du rapport de simplification non encore implémentés sur cette branche :

### ARCHIVE
- `archive/dns-txt-attestation` — code retiré de main, ~200 LOC
- `archive/mini-llm-l402` — code retiré, ~600 LOC + 1 table
- `archive/htlc-multihop` — code retiré, ~500 LOC + 1 table droppée v84
- 13 outils MCP non-utilisés — déjà retirés du `server-public.ts` (commit 2df57e7), restent dans `server.ts` pour self-hosters

### DÉSACTIVE — câblage des checks ✅ DONE (commits ea10cff → 413ec07)

- ✅ `config.FULFILL_ENABLED` (commit ea10cff) — process.env migration + default false
- ✅ `config.MINI_LLM_ENABLED` (commit 251619e) — controller construction gated
- ✅ `config.CLAIM_ENGINE_ENABLED` (commit 9e40506) — 4 routes + payout cron gated
- ✅ `config.AGENT_BONDS_ENABLED` (commit 7082cb3) — 4 routes + 2 crons gated
- ✅ `config.AEPS_DISPUTE_ENABLED` (commit 413ec07) — dispute + multi-hop routes + slash cron gated
- ✅ `config.FORK_DETECTION_ENABLED` (commit 413ec07) — observer routes gated

### Phase 10 inversée
- Renommer `POST /api/operator/register-endpoint` → `POST /api/operator/claim-listing`
- Implémenter Schnorr LN-pubkey verification (drop NIP-98 mandatory + DNS TXT mandatory)
- Optional `POST /api/operator/upgrade-verified` pour badge DNS TXT
- Migration v84 alter `operator_endpoint_registration` → `operator_listing_claims` + colonne `verified_via`

### V1 discovery_signal (raffinement)
- Compteurs précis `quarantine_5xx`, `quarantine_validator_violation`, `replay_state_penalty`, `not_meaningful` au lieu du bucket 'other'
- Exige instrumentation au niveau du repo `findCandidatesByCategory`
- Estimation `estimated_sats_saved_vs_diy` basée sur stats réelles `paid_probe_results.average_invoice_sats × pay_2xx_rate`

### Documentation
- Update `README.md` avec le nouveau pitch V2 et la liste des 3 outils MCP
- Update `docs/MCP.md`
- Update `claude-skills/satrank-l402/SKILL.md` pour refléter les 3 outils

### Distribution
- Re-publish `satrank-mcp@2.0.0` sur npm avec slim 3-tool variant
- Smithery release V2.0 avec spec mise à jour
- MCP registry update

## Cibles vs réalité (commit-by-commit)

| Métrique | Cible V2 | État après cette branche |
|---|---|---|
| LOC TypeScript | ~3 000 | ~12 000 (slim public + flags câblés ; archive branches deferred) |
| Tables actives | 8 | ~80 (flags off désactivent surface, tables conservées) |
| Endpoints HTTP exposés (par défaut prod) | 5 | ~25 (FULFILL stays opt-in ; flag-on autres surfaces ≈ legacy) |
| Outils MCP exposés (slim public V2.0) | 3 | ✅ **3** |
| Feature flags câblés (commits ea10cff, 251619e, 9e40506, 7082cb3, 413ec07) | 6 | ✅ **6/6** |

La branche actuelle ship :
- la **surface MCP slim V2** (commit 2df57e7)
- l'**observability discovery_signal** (commit fb788f1)
- les **6 feature flags V2 câblés** dans app.ts (commits ea10cff → 413ec07)
- la **doc alignée V2** (commit c7065fd)

Reste deferred (refacto plus profonde, demande validation au merge) :
- Branches `archive/dns-txt-attestation`, `archive/mini-llm-l402`, `archive/htlc-multihop` + retrait code (~5000 LOC)
- Phase 10 inversée (claim Schnorr LN-pubkey allégé, drop NIP-98 mandatory)
- V1 discovery_signal raffinement (compteurs précis quarantine_5xx)

## Distribution V2.0.0

`mcp-pkg/` (gitignored, build artifact) prêt pour publication :
- `mcp-pkg/package.json` bumpé `1.0.1 → 2.0.0`
- `mcp-pkg/manifest.json` + `mcp-pkg/server.json` bumpés `1.0.1 → 2.0.0`
- `mcp-pkg/dist/mcp/server-public.js` rebuild depuis `src/mcp/server-public.ts`
- `mcp-pkg/satrank-mcp-2.0.0.tgz` packed (10.3 kB, 6 files)
- Smoke `tools/list` retourne exactement 3 entries

Manuel à exécuter par Romain (npm token absent du shell Claude Code) :
```bash
cd /Users/lochju/satrank/mcp-pkg
npm whoami            # vérifier auth
npm publish           # 1.0.0 → 2.0.0 (BREAKING : surface 16→3)
# Smithery + MCP registry : update via CLI/UI propres
```

## Réversibilité

Tout commit de cette branche est :
- Additif ou minimaliste (pas de DROP TABLE, pas de fichier supprimé)
- Reverse-compatible (defaults preserve comportement actuel)
- Documenté
- Tests verts à chaque commit

Merge dans main demande validation Romain. Branch peut rester ouverte indéfiniment sans pourrir main.
