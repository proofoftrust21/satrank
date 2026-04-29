// Configuration validation and loading at startup
import dotenv from 'dotenv';
import { z } from 'zod';
import { DEFAULT_NOSTR_RELAYS_CSV } from './nostr/relays';

dotenv.config();

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Phase 12B — PostgreSQL 16 connection.
  // Format: postgresql://user:password@host:port/database
  // Default pool size tuned per worker (see DB_POOL_MAX_API / DB_POOL_MAX_CRAWLER).
  DATABASE_URL: z.string().default('postgresql://satrank:satrank@localhost:5432/satrank'),
  DB_POOL_MAX_API: z.coerce.number().int().positive().default(30),
  DB_POOL_MAX_CRAWLER: z.coerce.number().int().positive().default(20),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  CORS_ORIGIN: z.string().url('CORS_ORIGIN must be a valid URL').default('http://localhost:3000')
    .refine(v => process.env.NODE_ENV !== 'production' || v.startsWith('https://'), 'CORS_ORIGIN must use https:// in production'),
  // API key for write endpoints
  API_KEY: z.string().min(1).optional(),
  // LND REST API (primary Lightning source)
  LND_REST_URL: z.string().url().default('http://localhost:8080'),
  LND_MACAROON_PATH: z.string().default('/app/data/readonly.macaroon'),
  LND_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  // Auto-indexation rate limit
  AUTO_INDEX_MAX_PER_MINUTE: z.coerce.number().int().positive().default(10),
  // Crawl intervals (ms) — each source runs on its own timer
  CRAWL_INTERVAL_LND_GRAPH_MS: z.coerce.number().int().positive().default(3_600_000), // 1 hour
  CRAWL_INTERVAL_LNPLUS_MS: z.coerce.number().int().positive().default(86_400_000),   // 24 hours
  CRAWL_INTERVAL_PROBE_MS: z.coerce.number().int().positive().default(60_000),       // 1 min (probe cycles chain continuously)
  // Probe routing: max probes per second (rate limiter)
  PROBE_MAX_PER_SECOND: z.coerce.number().int().positive().default(30),
  // Probe routing: amount in sats to test routes with
  PROBE_AMOUNT_SATS: z.coerce.number().int().positive().default(1000),
  // Registry crawler — discovers L402 endpoints from 402index.io
  CRAWL_INTERVAL_REGISTRY_MS: z.coerce.number().int().positive().default(86_400_000), // 24 hours
  // Node pubkey — shown in API responses so agents can open a direct channel
  NODE_PUBKEY: z.string().regex(/^(02|03)[a-f0-9]{64}$/).optional(),
  // Nostr — publish scores as NIP-85 kind 30382 events
  NOSTR_PRIVATE_KEY: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  NOSTR_RELAYS: z.string().default(DEFAULT_NOSTR_RELAYS_CSV),
  NOSTR_PUBLISH_INTERVAL_MS: z.coerce.number().int().positive().default(1_800_000), // 30 min — delta-only (unchanged agents are skipped)
  NOSTR_MIN_SCORE: z.coerce.number().int().min(0).default(30), // only publish nodes with score >= this
  // Phase 8 — multi-kind endorsements (30382 node / 30383 endpoint / 30384 service)
  // Opt-in : OFF par défaut tant que Checkpoint 2 n'est pas validé en prod.
  // Le scan tourne en parallèle du NIP-85 legacy (kind 30382 single-source) —
  // les deux coexistent pendant la rollout jusqu'à sunset de l'ancien.
  NOSTR_MULTI_KIND_ENABLED: z.coerce.boolean().default(false),
  NOSTR_MULTI_KIND_INTERVAL_MS: z.coerce.number().int().positive().default(300_000), // 5 min
  NOSTR_MULTI_KIND_SCAN_WINDOW_SEC: z.coerce.number().int().positive().default(900), // 15 min (3× interval avec overlap)
  NOSTR_MULTI_KIND_MAX_PER_TYPE: z.coerce.number().int().positive().default(500), // safeguard premier boot
  // NIP-09 deletion requests (kind 5). OFF par défaut — on garde en réserve pour
  // Phase 8bis ou quand un relai non-NIP-33 est observé en pratique (le NIP-33
  // replaceable rend la deletion redondante pour les 30382/30383/30384).
  NOSTR_NIP09_ENABLED: z.coerce.boolean().default(false),
  // LND invoice macaroon — needed for /api/deposit (addInvoice + lookupInvoice)
  // Separate from LND_MACAROON_PATH which is readonly. Bake with:
  //   lncli bakemacaroon invoices:read invoices:write --save_to invoice.macaroon
  LND_INVOICE_MACAROON_PATH: z.string().optional(),
  // LND admin macaroon — needed for /api/probe (payInvoice on L402 challenges).
  // Scope is deliberately narrower than full admin: offchain:read offchain:write
  // is sufficient for payInvoice. Keep this file chmod 600 — it can drain the
  // routing node. Bake with:
  //   lncli bakemacaroon offchain:read offchain:write --save_to pay.macaroon
  LND_ADMIN_MACAROON_PATH: z.string().optional(),
  // Sim 7 follow-up — paid-probe cron runs in the crawler. Pays L402 invoices
  // for stages 3-5 (payment / delivery / quality) of the 5-stage L402
  // contract decomposition. OPT-IN via PAID_PROBE_ENABLED=true. Defaults
  // chosen conservatively: 5 sats/probe × 10 probes/cycle × 4 cycles/day
  // = 200 sats/day max, ~6000 sats/month (~$2.50/month at $0.0004/sat).
  PAID_PROBE_ENABLED: z.coerce.boolean().default(false),
  PAID_PROBE_INTERVAL_HOURS: z.coerce.number().int().positive().default(6),
  PAID_PROBE_MAX_PER_PROBE_SATS: z.coerce.number().int().positive().default(5),
  /** Per-cycle cap. Each cron tick won't spend more than this. With multiple
   *  ticks per day, the daily cumulative could exceed this — see the rolling
   *  24h cap below to bound the total daily burn. */
  PAID_PROBE_TOTAL_BUDGET_SATS: z.coerce.number().int().positive().default(50),
  /** Audit r2 (2026-04-29) — rolling 24h cap on cumulative paid_probe
   *  spending. Each cycle reads the last-24h spending from oracle_revenue_log
   *  and caps itself at (BUDGET_PER_24H - spent_last_24h). Set to 0 to
   *  disable the rolling guard (only per-cycle cap remains). Default 1000
   *  ≈ $0.40/day, ~$12/month — covers τ=7d decay refresh + new endpoint
   *  bootstrap without runaway. */
  PAID_PROBE_BUDGET_PER_24H_SATS: z.coerce.number().int().nonnegative().default(1000),
  PAID_PROBE_MAX_PER_CYCLE: z.coerce.number().int().positive().default(10),
  // Excellence pass — validate every newly ingested endpoint with a single
  // paid probe to seed stages 3-5 with n_obs=1, breaking the cold-start
  // chicken-and-egg loop (no demand signal → no paid probe → no
  // stage_posteriors → not visible in /api/intent → no demand signal).
  PAID_PROBE_VALIDATE_NEW: z.coerce.boolean().default(false),
  // Excellence pass — monthly sweep cron: probes the medium-demand band
  // (endpoints not in the daily Pareto-80 but with some signal — recent
  // intent query, multi-source curation, healthy upstream score). Detects
  // drift on endpoints that fell out of the hot tier without being
  // explicitly deprecated. Default OFF; toggle on for excellence-tier
  // catalogue coverage.
  PAID_PROBE_SWEEP_ENABLED: z.coerce.boolean().default(false),
  // Weekly tick: 25 probes × 4 weeks × ~25 sats avg = ~2 500 sats/month — covers
  // 100 endpoints/month so the full ~450-endpoint catalogue rotates through
  // every 4-5 months. The freshAfter window prevents re-probing a row that the
  // daily Pareto-80 cron just hit.
  PAID_PROBE_SWEEP_INTERVAL_HOURS: z.coerce.number().int().positive().default(24 * 7),
  PAID_PROBE_SWEEP_MAX_PER_RUN: z.coerce.number().int().positive().default(25),
  PAID_PROBE_SWEEP_FRESH_AFTER_DAYS: z.coerce.number().int().positive().default(30),
  // Probe safety rails — caps on the L402 invoice SatRank will pay and on the
  // probe round-trip fetch duration. Per-probe defaults are conservative;
  // override via env for stress demos.
  PROBE_MAX_INVOICE_SATS: z.coerce.number().int().positive().default(1000),
  PROBE_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // Rate limits for /api/probe (Phase 9 C8, tightened in Phase 11bis).
  // Per-token protects individual token-holders from unbounded spend; global
  // protects the LN node from a many-tokens distributed attack AND caps the
  // economic throughput of any remaining SSRF-shaped abuse (F-01-bis audit).
  // Window is a rolling 1h slot. Defaults: 10/h/token, 20/h global — ~1 probe
  // every 3 minutes across all callers. Override via env for legit burst use.
  PROBE_RATE_LIMIT_PER_TOKEN_PER_HOUR: z.coerce.number().int().positive().default(10),
  PROBE_RATE_LIMIT_GLOBAL_PER_HOUR: z.coerce.number().int().positive().default(20),
  // Zap-receipt mining — builds (nostr_pubkey, ln_pubkey) mappings for Stream B
  ZAP_MINING_RELAYS: z.string().default(
    'wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net,wss://relay.nostr.band,wss://nostr.wine,wss://relay.snort.social,wss://nostr-pub.wellorder.net,wss://offchain.pub,wss://eden.nostr.land',
  ),
  ZAP_MINING_INTERVAL_MS: z.coerce.number().int().positive().default(86_400_000), // 24 hours
  ZAP_MINING_PAGE_SIZE: z.coerce.number().int().positive().default(500),
  ZAP_MINING_MAX_PAGES: z.coerce.number().int().positive().default(40),
  ZAP_CUSTODIAL_THRESHOLD: z.coerce.number().int().positive().default(5),
  // Crawler metrics server — /metrics exposed on this port so Prometheus can
  // scrape crawlDuration, probe counters, Nostr publish stats. Auth mirrors
  // the api container (localhost free, external X-API-Key).
  CRAWLER_METRICS_PORT: z.coerce.number().int().positive().default(9091),

  // --- Report bonus (Tier 2 economic incentive) ---
  // OFF by default. Flip to "true" only after the 30-day Tier 1 observation
  // window if organic report growth stalls. See REPORT-INCENTIVE-DESIGN.md.
  REPORT_BONUS_ENABLED: z.coerce.boolean().default(false),
  /** Eligible reports needed to earn 1 sat of balance credit. 10 → 10% discount. */
  REPORT_BONUS_THRESHOLD: z.coerce.number().int().positive().default(10),
  /** Max bonus credits per reporter per UTC day. 3 × 1 sat = 30 eligible reports. */
  REPORT_BONUS_DAILY_CAP: z.coerce.number().int().positive().default(3),
  /** Sats credited per bonus. */
  REPORT_BONUS_SATS: z.coerce.number().int().positive().default(1),
  /** Minimum reporter SatRank score to count without NIP-98 signature. */
  REPORT_BONUS_MIN_REPORTER_SCORE: z.coerce.number().int().min(0).default(30),
  /** Minimum npub age (days) when the reporter signs with NIP-98 instead of having a SatRank score. */
  REPORT_BONUS_MIN_NPUB_AGE_DAYS: z.coerce.number().int().positive().default(30),
  /** Canonical public hostname used to build the URL NIP-98 signatures must bind to.
   *  Hardcoding this (instead of trusting the incoming Host header) closes audit H3 —
   *  the client cannot trick the verifier into accepting a signature bound to a
   *  different hostname they control. */
  PUBLIC_HOST: z.string().default('satrank.dev'),
  /** SAFE-ratio shift that triggers automatic rollback (disable bonus in-process). */
  REPORT_BONUS_ROLLBACK_RATIO: z.coerce.number().positive().default(1.3),
  /** Check interval for the auto-rollback guard (ms). */
  REPORT_BONUS_GUARD_INTERVAL_MS: z.coerce.number().int().positive().default(15 * 60_000),

  // --- Phase 1 dual-write (transactions table enrichment) ---
  // Three-valued flag driving the shadow-write strategy during the Phase 1
  // rollout window (48-72h dry-run before flipping to `active`) :
  //   off     — legacy 9-col INSERT only (production default, zero risk).
  //   dry_run — legacy 9-col INSERT + NDJSON shadow log of the enriched row.
  //             The 4 new columns stay NULL in DB so the crawler can be
  //             observed without mutating the ledger.
  //   active  — single 13-col INSERT. New columns populated; NDJSON silent.
  // See docs/PHASE-1-DESIGN.md §5 for the rollout runbook.
  TRANSACTIONS_DUAL_WRITE_MODE: z.enum(['off', 'dry_run', 'active']).default('off'),
  // Primary NDJSON path for dry-run shadow writes. Mounted as a Docker volume
  // in production. If the path is not writable at boot, dualWriteLogger falls
  // back to `${cwd}/logs/dual-write-dryrun.ndjson` and logs WARN; if the
  // fallback also fails, logging is disabled (ERROR) and active/dry_run modes
  // degrade gracefully so the API never crashes over a logging issue.
  TRANSACTIONS_DRY_RUN_LOG_PATH: z.string().default('/var/log/satrank/dual-write-dryrun.ndjson'),
  // Phase 1 — paid-target-query → outcome reconciliation window.
  // `tokenQueryLogTimeoutWorker` scans `token_query_log` for rows older
  // than this threshold whose query intent was never closed out by a
  // matching /report. Per §4 case 3 of docs/PHASE-1-DESIGN.md the worker
  // writes NOTHING to `transactions` (the stale token_query_log row stands
  // as the lone trace of an unresolved intent); the threshold only gates
  // how old a row must be before the worker classifies it as "timed out"
  // for metrics.
  INTENT_OUTCOME_TIMEOUT_HOURS: z.coerce.number().int().positive().default(24),

  // Phase 12A A3 — staging/bench bypass for the L402 paid-endpoint gate
  // AND for the /metrics auth. Enabled only on the staging bench VM so
  // k6/wrk can hit paid routes without minting tokens and Prometheus can
  // scrape /metrics from the docker bridge gateway.
  //
  // Strict parse: only the literal strings "true" or "1" enable the flag.
  // z.coerce.boolean() would coerce "false" / "no" / "0" to true as well
  // (non-empty string → true), defeating the fail-safe.
  //
  // SAFETY: the fail-safe further down refuses to boot if this is set
  // together with NODE_ENV=production. Intentional double-gate.
  L402_BYPASS: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  // --- Phase 14D.3.0 — L402 native middleware ---
  // Secret HMAC pour sceller les macaroons L402 synthetiques. Doit etre
  // 32 octets hex (64 chars). Sans ce secret, le middleware L402 natif refuse
  // de servir les routes payantes. Rotation : generer
  //   openssl rand -hex 32
  // et injecter via .env.production sans rsync --delete. Ne jamais logger.
  L402_MACAROON_SECRET: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'L402_MACAROON_SECRET must be 32-byte hex (64 chars)')
    .optional(),
  // Duree de vie de l'invoice BOLT11 generee pour le challenge L402 (secondes).
  L402_INVOICE_EXPIRY_SECONDS: z.coerce.number().int().positive().default(600),
  // Prix par defaut du challenge L402 en sats (quand la route n'a pas de prix
  // explicite dans la pricing map). Aligne sur la doc publique Phase 14 :
  // 1 sat per request, tier 1 rate 1.0.
  L402_DEFAULT_PRICE_SATS: z.coerce.number().int().positive().default(1),
  // Operator bypass — shared secret verifie par timing-safe equal contre le
  // header X-Operator-Token. Match => passe-plat du gate L402 (free unlimited
  // access). Utilise pour tests admin SatRank + health checks CI/CD. Leak =
  // unlimited free access aux paid endpoints. Rotate :
  //   openssl rand -hex 32
  OPERATOR_BYPASS_SECRET: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'OPERATOR_BYPASS_SECRET must be 32-byte hex (64 chars)')
    .optional(),
  // Security C1+H1 — Phase 6.0/6.1 MCP intent + DVM intent-resolve fetch
  // /api/intent côté SATRANK_API_BASE. Default = prod publique. Validated
  // here (https://) pour empêcher SSRF (file://, http://internal-IP, etc.).
  // Localhost autorisé pour les tests et les operators qui font tourner
  // leur propre instance bilatéralement.
  SATRANK_API_BASE: z
    .string()
    .url()
    .refine(
      (s) => {
        try {
          const u = new URL(s);
          return (
            u.protocol === 'https:' ||
            (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))
          );
        } catch {
          return false;
        }
      },
      { message: 'SATRANK_API_BASE must be https:// or http://localhost' },
    )
    .default('https://satrank.dev'),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  process.stderr.write(`Invalid configuration: ${JSON.stringify(parsed.error.format())}\n`);
  process.exit(1);
}

// Phase 12A A3 — hard fail-safe : the L402 bypass is a staging/bench mode
// only. Refusing the combo NODE_ENV=production + L402_BYPASS=true at boot
// prevents every worst case where the flag leaks into a production .env
// (paid endpoints served for free + /metrics exposed without auth).
if (parsed.data.NODE_ENV === 'production' && parsed.data.L402_BYPASS) {
  process.stderr.write(
    'REFUSED: L402_BYPASS=true with NODE_ENV=production. The bypass is a '
    + 'staging/bench mode only — it would open paid endpoints and /metrics '
    + 'auth. Unset L402_BYPASS or flip NODE_ENV to development/test.\n'
  );
  process.exit(1);
}

// In production, API_KEY is required
if (parsed.data.NODE_ENV === 'production') {
  if (!parsed.data.API_KEY) {
    process.stderr.write('API_KEY is required in production\n');
    process.exit(1);
  }
  // Phase 11ter F-05: the SSRF self-block requires the public IP to be
  // injected via env, not baked into source. Without it, a probe target that
  // resolves to our own ingress would bypass the block.
  if (!process.env.SERVER_IP) {
    process.stderr.write('SERVER_IP is required in production (SSRF self-block)\n');
    process.exit(1);
  }
}

// Guard against accidental production deployment without NODE_ENV
// If secrets are set but NODE_ENV defaulted to 'development', the process looks
// misconfigured — refuse to start to prevent silent auth bypass
if (
  parsed.data.NODE_ENV === 'development' &&
  parsed.data.API_KEY
) {
  process.stderr.write(
    'NODE_ENV is \'development\' but production secret API_KEY is set. ' +
    'Set NODE_ENV=production explicitly or remove the secret.\n'
  );
  process.exit(1);
}

// Reject obvious placeholders that must never reach production
const PLACEHOLDER_KEYS = ['changeme-in-production', 'changeme', 'changeme_generate_with_openssl_rand_hex_32'];
for (const field of ['API_KEY'] as const) {
  const val = parsed.data[field];
  if (val && PLACEHOLDER_KEYS.includes(val.trim().toLowerCase())) {
    process.stderr.write(`${field} contains a placeholder. Generate a real key: openssl rand -hex 32\n`);
    process.exit(1);
  }
}

// Warn loudly when optional features are silently disabled in production.
// These are not fatal (the rest of the API still works) but the operator MUST
// know that a feature is degraded so they don't ship a half-broken product.
if (parsed.data.NODE_ENV === 'production') {
  const degradedFeatures: string[] = [];
  if (!parsed.data.LND_INVOICE_MACAROON_PATH) {
    degradedFeatures.push('POST /api/deposit invoice generation (set LND_INVOICE_MACAROON_PATH)');
  }
  if (!parsed.data.NOSTR_PRIVATE_KEY) {
    degradedFeatures.push('NIP-85 Nostr publishing (set NOSTR_PRIVATE_KEY)');
  }
  if (!parsed.data.NODE_PUBKEY) {
    degradedFeatures.push('X-SatRank-Tip header (set NODE_PUBKEY)');
  }
  if (degradedFeatures.length > 0) {
    process.stderr.write('\n');
    process.stderr.write('═══════════════════════════════════════════════════════════════════\n');
    process.stderr.write('⚠  DEGRADED FEATURES IN PRODUCTION ⚠\n');
    process.stderr.write('═══════════════════════════════════════════════════════════════════\n');
    for (const f of degradedFeatures) {
      process.stderr.write(`  • ${f}\n`);
    }
    process.stderr.write('═══════════════════════════════════════════════════════════════════\n\n');
  }
}

export const config = parsed.data;
/** Map of optional features → whether they are configured and usable.
 *  Exposed via /api/health so operators can detect silent degradation. */
export const featureFlags = {
  depositInvoiceGeneration: !!parsed.data.LND_INVOICE_MACAROON_PATH,
  nostrPublishing: !!parsed.data.NOSTR_PRIVATE_KEY,
  pathfindingProbe: !!parsed.data.LND_MACAROON_PATH,
  nodeChannelHint: !!parsed.data.NODE_PUBKEY,
  l402Bypass: parsed.data.L402_BYPASS,
  l402Native: !!parsed.data.L402_MACAROON_SECRET && !!parsed.data.LND_INVOICE_MACAROON_PATH,
} as const;
