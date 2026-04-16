// Configuration validation and loading at startup
import dotenv from 'dotenv';
import { z } from 'zod';
import { DEFAULT_NOSTR_RELAYS_CSV } from './nostr/relays';

dotenv.config();

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DB_PATH: z.string().default('./data/satrank.db'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  CORS_ORIGIN: z.string().url('CORS_ORIGIN must be a valid URL').default('http://localhost:3000')
    .refine(v => process.env.NODE_ENV !== 'production' || v.startsWith('https://'), 'CORS_ORIGIN must use https:// in production'),
  // API key for write endpoints — will be replaced by L402/Aperture
  API_KEY: z.string().min(1).optional(),
  // Shared secret between Aperture and Express — defense in depth for L402 gate
  APERTURE_SHARED_SECRET: z.string().min(1).optional(),
  // Observer Protocol crawler
  OBSERVER_BASE_URL: z.string().url().default('https://api.observerprotocol.org'),
  OBSERVER_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  // LND REST API (primary Lightning source)
  LND_REST_URL: z.string().url().default('http://localhost:8080'),
  LND_MACAROON_PATH: z.string().default('/app/data/readonly.macaroon'),
  LND_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  // Auto-indexation rate limit
  AUTO_INDEX_MAX_PER_MINUTE: z.coerce.number().int().positive().default(10),
  // Crawl intervals (ms) — each source runs on its own timer
  CRAWL_INTERVAL_OBSERVER_MS: z.coerce.number().int().positive().default(300_000),    // 5 min
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
  // LND invoice macaroon — needed for /api/deposit (addInvoice + lookupInvoice)
  // Separate from LND_MACAROON_PATH which is readonly. Bake with:
  //   lncli bakemacaroon invoices:read invoices:write --save_to invoice.macaroon
  LND_INVOICE_MACAROON_PATH: z.string().optional(),
  // Zap-receipt mining — builds (nostr_pubkey, ln_pubkey) mappings for Stream B
  ZAP_MINING_RELAYS: z.string().default(
    'wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net,wss://relay.nostr.band,wss://nostr.wine,wss://relay.snort.social,wss://nostr-pub.wellorder.net,wss://offchain.pub,wss://eden.nostr.land',
  ),
  ZAP_MINING_INTERVAL_MS: z.coerce.number().int().positive().default(86_400_000), // 24 hours
  ZAP_MINING_PAGE_SIZE: z.coerce.number().int().positive().default(500),
  ZAP_MINING_MAX_PAGES: z.coerce.number().int().positive().default(40),
  ZAP_CUSTODIAL_THRESHOLD: z.coerce.number().int().positive().default(5),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  process.stderr.write(`Invalid configuration: ${JSON.stringify(parsed.error.format())}\n`);
  process.exit(1);
}

// In production, API_KEY and APERTURE_SHARED_SECRET are required
if (parsed.data.NODE_ENV === 'production') {
  if (!parsed.data.API_KEY) {
    process.stderr.write('API_KEY is required in production\n');
    process.exit(1);
  }
  if (!parsed.data.APERTURE_SHARED_SECRET) {
    process.stderr.write('APERTURE_SHARED_SECRET is required in production\n');
    process.exit(1);
  }
}

// Guard against accidental production deployment without NODE_ENV
// If secrets are set but NODE_ENV defaulted to 'development', the process looks
// misconfigured — refuse to start to prevent silent auth bypass
if (
  parsed.data.NODE_ENV === 'development' &&
  (parsed.data.API_KEY || parsed.data.APERTURE_SHARED_SECRET)
) {
  process.stderr.write(
    'NODE_ENV is \'development\' but production secrets (API_KEY/APERTURE_SHARED_SECRET) are set. ' +
    'Set NODE_ENV=production explicitly or remove the secrets.\n'
  );
  process.exit(1);
}

// Reject obvious placeholders that must never reach production
const PLACEHOLDER_KEYS = ['changeme-in-production', 'changeme', 'changeme_generate_with_openssl_rand_hex_32'];
for (const field of ['API_KEY', 'APERTURE_SHARED_SECRET'] as const) {
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
} as const;
