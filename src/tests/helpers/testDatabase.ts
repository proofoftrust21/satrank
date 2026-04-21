// Phase 12B — Postgres test harness.
//
// Per-test-file ephemeral database. CREATE DATABASE ... TEMPLATE
// satrank_test_template is fast (~100-200ms) because the schema is cloned
// block-by-block. Each test file gets its own database so writes in one file
// never leak into another file, matching the isolation the old SQLite
// `:memory:` contract gave us for free.
//
// Lifecycle:
//   - vitest globalSetup (src/tests/helpers/globalSetup.ts) ensures the
//     template DB exists and has postgres-schema.sql applied to schema v41.
//   - Each test file calls `setupTestPool()` in `beforeAll` and
//     `teardownTestPool()` in `afterAll`.
//   - Seed values that must exist (deposit_tiers) are pre-loaded in the
//     template, so per-file DBs start identical to prod post-bootstrap.
import { Pool, types } from 'pg';
import { randomUUID } from 'node:crypto';

// BIGINT (OID 20) + NUMERIC (OID 1700) → JS number.
// Matches src/database/connection.ts. Tests that bypass connection.ts still
// need these to avoid string-vs-number assertion drift.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

export interface TestDb {
  pool: Pool;
  databaseUrl: string;
  dbName: string;
}

function adminUrl(): string {
  // Connect to the template1 administrative DB to issue CREATE/DROP.
  const base = process.env.DATABASE_URL ?? 'postgresql://satrank:satrank@localhost:5432/satrank';
  return base.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
}

function withDatabase(url: string, dbName: string): string {
  return url.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
}

export const TEMPLATE_DB = 'satrank_test_template';

/** Creates an ephemeral DB from the template and returns an open pool bound to it. */
export async function setupTestPool(): Promise<TestDb> {
  const admin = new Pool({ connectionString: adminUrl(), max: 1 });
  const dbName = `satrank_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  try {
    await admin.query(`CREATE DATABASE ${dbName} TEMPLATE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  const databaseUrl = withDatabase(process.env.DATABASE_URL ?? 'postgresql://satrank:satrank@localhost:5432/satrank', dbName);
  const pool = new Pool({ connectionString: databaseUrl, max: 4, idleTimeoutMillis: 1_000 });
  return { pool, databaseUrl, dbName };
}

/** Closes the pool and drops the ephemeral DB. Safe to call more than once. */
export async function teardownTestPool(db: TestDb): Promise<void> {
  try {
    await db.pool.end();
  } catch {
    /* pool may already be closed */
  }
  const admin = new Pool({ connectionString: adminUrl(), max: 1 });
  try {
    // Force-disconnect any stragglers before DROP. WITH (FORCE) needs PG ≥ 13.
    await admin.query(`DROP DATABASE IF EXISTS ${db.dbName} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/** Truncates every application table in the current pool. Useful when a test
 *  file creates heavy fixtures and wants a clean slate between `describe`s
 *  without paying for a full CREATE DATABASE cycle. Preserves `deposit_tiers`
 *  (seed) and `schema_version`. */
export async function truncateAll(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('schema_version', 'deposit_tiers')
  `);
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  await pool.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
