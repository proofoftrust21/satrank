// SatRank V3 — typed env config.
//
// Single z.object schema parsed once at boot. Anything that needs a value
// at runtime imports `config`. Nothing else.

import { z } from 'zod';

const schema = z.object({
  // --- Server ---
  PORT: z.coerce.number().int().positive().default(3000),
  SATRANK_API_BASE: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // --- Postgres ---
  DATABASE_URL: z.string().min(1),

  // --- LND (REST) ---
  LND_REST_URL: z.string().url().optional(),
  LND_MACAROON_HEX: z.string().optional(),
  /** Alternative to LND_MACAROON_HEX: path to a binary macaroon file ;
   *  read once at boot and converted to hex. Lets ops keep macaroons on
   *  disk (lncli bakemacaroon → file) instead of pasting hex into env. */
  LND_MACAROON_PATH: z.string().optional(),
  LND_TLS_CERT_PATH: z.string().optional(),

  // --- Nostr (kind 30782 trust assertions) ---
  NOSTR_PRIVATE_KEY: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  NOSTR_RELAYS: z.string().default('wss://relay.damus.io,wss://nos.lol,wss://nostr.mom'),

  // --- L402 native gate ---
  L402_MACAROON_SECRET: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  L402_INTENT_PRICE_SATS: z.coerce.number().int().positive().default(2),

  // --- Probe + scoring ---
  PROBE_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  PROBE_MAX_INVOICE_SATS: z.coerce.number().int().positive().default(1000),
  /** Below this n_obs per stage, an endpoint is flagged is_meaningful=false. */
  MEANINGFUL_N_OBS_MIN: z.coerce.number().int().positive().default(3),

  // --- Crawler ---
  CRAWLER_INTERVAL_SEC: z.coerce.number().int().positive().default(3600),
  PAID_PROBE_ENABLED: z.coerce.boolean().default(false),
  PAID_PROBE_DAILY_BUDGET_SATS: z.coerce.number().int().positive().default(2000),

  // --- Budget transparency ---
  REVENUE_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);
