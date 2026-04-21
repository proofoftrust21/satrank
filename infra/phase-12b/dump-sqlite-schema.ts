// Phase 12B B3 — dump the final consolidated SQLite schema from a fresh migration run.
// Run with: npx tsx infra/phase-12b/dump-sqlite-schema.ts > infra/phase-12b/sqlite-final-schema.sql
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations';

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
runMigrations(db);

// Dump schema in creation order (mirrors .schema output)
const rows = db
  .prepare(
    `SELECT type, name, tbl_name, sql
     FROM sqlite_master
     WHERE type IN ('table', 'index', 'trigger', 'view')
       AND sql IS NOT NULL
       AND name NOT LIKE 'sqlite_%'
     ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END, name`,
  )
  .all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;

console.log('-- Phase 12B — SQLite final consolidated schema');
console.log(`-- Dumped at ${new Date().toISOString()}`);
console.log(`-- Source: src/database/migrations.ts (all versions applied)\n`);
for (const r of rows) {
  console.log(`-- ${r.type}: ${r.name}`);
  console.log(`${r.sql};\n`);
}

const version = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
console.log(`-- final schema_version: ${version.v}`);
