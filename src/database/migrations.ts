// Phase 12B — Postgres bootstrap (idempotent).
// The long SQLite v1..v41 history is consolidated into a single DDL file
// (src/database/postgres-schema.sql). We apply it once when schema_version
// is empty; subsequent boots are a no-op.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { logger } from '../logger';

const CONSOLIDATED_VERSION = 41;
const SCHEMA_PATH = join(__dirname, 'postgres-schema.sql');

/** Reads and applies postgres-schema.sql if schema_version is missing / below target. */
export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await ensureSchemaVersionTable(client);

    const current = await currentVersion(client);
    if (current >= CONSOLIDATED_VERSION) {
      logger.info({ current }, 'schema up to date, skipping bootstrap');
      return;
    }

    const sql = readFileSync(SCHEMA_PATH, 'utf8');
    logger.info({ from: current, to: CONSOLIDATED_VERSION }, 'applying consolidated Postgres schema');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    const applied = await currentVersion(client);
    logger.info({ version: applied }, 'Postgres schema applied');
  } finally {
    client.release();
  }
}

async function ensureSchemaVersionTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER PRIMARY KEY,
      applied_at  TEXT NOT NULL,
      description TEXT NOT NULL
    )
  `);
}

async function currentVersion(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ v: number | null }>(
    'SELECT MAX(version)::int AS v FROM schema_version',
  );
  return rows[0]?.v ?? 0;
}
