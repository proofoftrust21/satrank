// SatRank V3 — Postgres pool + schema bootstrap.
//
// One pool. One schema file. No migrations folder. Idempotent on every boot.

import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error({ err: err.message }, 'pg pool: idle client errored');
});

export async function bootstrapSchema(): Promise<void> {
  // ESM: __dirname not available — derive from import.meta.url.
  const here = new URL(import.meta.url).pathname;
  const dir = here.substring(0, here.lastIndexOf('/'));
  const schemaPath = join(dir, 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  logger.info('db: schema bootstrap complete');
}

export async function closePool(): Promise<void> {
  await pool.end();
}
