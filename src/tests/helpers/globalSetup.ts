// Phase 12B — vitest globalSetup.
//
// Runs once before the entire test run (not per file). Ensures that a
// template database exists with the consolidated schema + deposit_tiers seed
// applied, so every test file's `setupTestPool()` just has to clone it.
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEMPLATE_DB } from './testDatabase';

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
  } finally {
    await template.end();
  }
}

export async function teardown(): Promise<void> {
  // Leave the template around between runs — next `setup()` short-circuits
  // when it detects schema_version is populated.
}
