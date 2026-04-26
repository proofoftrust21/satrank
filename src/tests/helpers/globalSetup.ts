// Phase 12B — vitest globalSetup.
//
// Runs once before the entire test run (not per file). Ensures that a
// template database exists with the consolidated schema + deposit_tiers seed
// applied, so every test file's `setupTestPool()` just has to clone it.
//
// Axe 1 — also applies incremental migrations (v42+) found in
// src/database/migrations so the template stays at HEAD without forcing
// a manual drop on each schema bump.
import { Pool } from 'pg';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TEMPLATE_DB } from './testDatabase';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'database', 'migrations');

async function applyPendingIncrementals(template: Pool): Promise<void> {
  if (!existsSync(MIGRATIONS_DIR)) return;
  const { rows: vRows } = await template.query<{ v: number | null }>(
    'SELECT MAX(version)::int AS v FROM schema_version',
  );
  const current = vRows[0]?.v ?? 0;

  const pending = readdirSync(MIGRATIONS_DIR)
    .filter(f => /^v\d+_.+\.sql$/.test(f))
    .map(file => {
      const match = file.match(/^v(\d+)_/);
      return { version: match ? Number(match[1]) : NaN, file };
    })
    .filter(m => Number.isFinite(m.version) && m.version > current)
    .sort((a, b) => a.version - b.version);

  for (const m of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, m.file), 'utf8');
    await template.query('BEGIN');
    try {
      await template.query(sql);
      await template.query('COMMIT');
    } catch (err) {
      await template.query('ROLLBACK');
      throw err;
    }
  }
}

function adminUrl(): string {
  const base = process.env.DATABASE_URL ?? 'postgresql://satrank:satrank@localhost:5432/satrank';
  return base.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
}

function templateUrl(): string {
  const base = process.env.DATABASE_URL ?? 'postgresql://satrank:satrank@localhost:5432/satrank';
  return base.replace(/\/[^/?]+(\?|$)/, `/${TEMPLATE_DB}$1`);
}

const DEPOSIT_TIERS: Array<[number, number, number]> = [
  [21,      1.0,  0 ],
  [1000,    0.5,  50],
  [10000,   0.2,  80],
  [100000,  0.1,  90],
  [1000000, 0.05, 95],
];

export async function setup(): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl(), max: 1 });
  try {
    const { rows } = await admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pg_database WHERE datname = $1`,
      [TEMPLATE_DB],
    );
    if (Number(rows[0]?.count ?? 0) === 0) {
      await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
    }
  } finally {
    await admin.end();
  }

  const template = new Pool({ connectionString: templateUrl(), max: 1 });
  try {
    const { rows } = await template.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'schema_version'`,
    );
    if (Number(rows[0]?.count ?? 0) === 0) {
      const schemaPath = join(__dirname, '..', '..', 'database', 'postgres-schema.sql');
      const sql = readFileSync(schemaPath, 'utf8');
      await template.query('BEGIN');
      try {
        await template.query(sql);
        const now = Date.now();
        for (const [min, rate, pct] of DEPOSIT_TIERS) {
          await template.query(
            `INSERT INTO deposit_tiers (min_deposit_sats, rate_sats_per_request, discount_pct, created_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (min_deposit_sats) DO NOTHING`,
            [min, rate, pct, now],
          );
        }
        await template.query('COMMIT');
      } catch (err) {
        await template.query('ROLLBACK');
        throw err;
      }
    }
    await applyPendingIncrementals(template);
  } finally {
    await template.end();
  }
}

export async function teardown(): Promise<void> {
  // Leave the template around between runs — next `setup()` short-circuits
  // when it detects schema_version is populated.
}
