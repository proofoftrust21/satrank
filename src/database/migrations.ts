// Phase 12B — Postgres bootstrap (idempotent).
// The long SQLite v1..v41 history is consolidated into a single DDL file
// (src/database/postgres-schema.sql). We apply it once when schema_version
// is empty; subsequent boots are a no-op.
//
// Axe 1 — incremental migrations (>v41) are loaded from
// src/database/migrations/vNN_*.sql and applied in order, each guarded by
// schema_version. Bootstrap installs jump straight to the latest version;
// existing installs apply only the missing increments.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { logger } from '../logger';

const CONSOLIDATED_VERSION = 41;
const SCHEMA_PATH = join(__dirname, 'postgres-schema.sql');
const MIGRATIONS_DIR = join(__dirname, 'migrations');

interface IncrementalMigration {
  version: number;
  file: string;
  sql: string;
}

/** Reads and applies postgres-schema.sql if schema_version is missing / below
 *  the consolidated baseline, then applies any incremental migrations
 *  (vNN > CONSOLIDATED_VERSION) found in MIGRATIONS_DIR. */
export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await ensureSchemaVersionTable(client);

    const current = await currentVersion(client);
    if (current < CONSOLIDATED_VERSION) {
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
    } else {
      logger.info({ current }, 'consolidated schema already applied');
    }

    await applyIncrementalMigrations(client);
  } finally {
    client.release();
  }
}

async function applyIncrementalMigrations(client: PoolClient): Promise<void> {
  if (!existsSync(MIGRATIONS_DIR)) return;

  const pending = readdirSync(MIGRATIONS_DIR)
    .filter(f => /^v\d+_.+\.sql$/.test(f))
    .map<IncrementalMigration>(file => {
      const match = file.match(/^v(\d+)_/);
      const version = match ? Number(match[1]) : NaN;
      return { version, file, sql: '' };
    })
    .filter(m => Number.isFinite(m.version) && m.version > CONSOLIDATED_VERSION)
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) return;

  const current = await currentVersion(client);
  const todo = pending.filter(m => m.version > current);
  if (todo.length === 0) {
    logger.info({ current }, 'no pending incremental migrations');
    return;
  }

  for (const migration of todo) {
    const sql = readFileSync(join(MIGRATIONS_DIR, migration.file), 'utf8');
    logger.info({ version: migration.version, file: migration.file }, 'applying incremental migration');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    logger.info({ version: migration.version }, 'incremental migration applied');
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
