// Configuration validation and loading at startup
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DB_PATH: z.string().default('./data/satrank.db'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  CORS_ORIGIN: z.string().url('CORS_ORIGIN must be a valid URL').default('http://localhost:3000'),
  // API key for write endpoints — will be replaced by L402/Aperture
  API_KEY: z.string().min(1).optional(),
  // Observer Protocol crawler
  OBSERVER_BASE_URL: z.string().url().default('https://api.observerprotocol.org'),
  OBSERVER_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  process.stderr.write(`Invalid configuration: ${JSON.stringify(parsed.error.format())}\n`);
  process.exit(1);
}

// In production, API_KEY is required
if (parsed.data.NODE_ENV === 'production' && !parsed.data.API_KEY) {
  process.stderr.write('API_KEY is required in production\n');
  process.exit(1);
}

// Reject obvious placeholders that must never reach production
const PLACEHOLDER_KEYS = ['changeme-in-production', 'changeme', 'changeme_generate_with_openssl_rand_hex_32'];
if (parsed.data.API_KEY && PLACEHOLDER_KEYS.includes(parsed.data.API_KEY.trim().toLowerCase())) {
  process.stderr.write('API_KEY contains a placeholder. Generate a real key: openssl rand -hex 32\n');
  process.exit(1);
}

export const config = parsed.data;
