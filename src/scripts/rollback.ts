// Rollback migrations to a target version.
// Usage: tsx src/scripts/rollback.ts <targetVersion>
// Example: tsx src/scripts/rollback.ts 4  → rolls back v6, v5 (keeps v1-v4)
import { getDatabase, closeDatabase } from '../database/connection';
import { rollbackTo, getAppliedVersions } from '../database/migrations';
import { logger } from '../logger';

const targetArg = process.argv[2];
if (!targetArg || isNaN(Number(targetArg))) {
  process.stderr.write('Usage: rollback <targetVersion>\n');
  process.stderr.write('Example: rollback 4  → removes v6, v5 (keeps v1-v4)\n');
  process.exit(1);
}

const target = Number(targetArg);
const db = getDatabase();

// Migrations v2-v4 use DROP COLUMN which requires SQLite 3.35+
const MIGRATIONS_REQUIRING_DROP_COLUMN = [2, 3, 4];

try {
  // Check SQLite version for DROP COLUMN support
  const sqliteVersion = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
  const [major, minor] = sqliteVersion.split('.').map(Number);
  const supportsDropColumn = major > 3 || (major === 3 && minor >= 35);

  const applied = getAppliedVersions(db);
  const currentMax = applied.length > 0 ? Math.max(...applied.map(v => v.version)) : 0;

  if (target >= currentMax) {
    logger.info({ current: currentMax, target }, 'Nothing to rollback');
    process.exit(0);
  }

  // Check if any migration requiring DROP COLUMN is in the rollback range
  const toRollback = applied.map(v => v.version).filter(v => v > target);
  const needsDropColumn = toRollback.some(v => MIGRATIONS_REQUIRING_DROP_COLUMN.includes(v));

  if (needsDropColumn && !supportsDropColumn) {
    logger.error(
      { sqliteVersion, target, versionsAffected: toRollback.filter(v => MIGRATIONS_REQUIRING_DROP_COLUMN.includes(v)) },
      'SQLite < 3.35 does not support DROP COLUMN. Migrations v2-v4 cannot be fully rolled back. Columns will remain in the table.',
    );
    process.exit(1);
  }

  logger.info({ current: currentMax, target, sqliteVersion }, 'Rolling back migrations');
  rollbackTo(db, target);

  const remaining = getAppliedVersions(db);
  logger.info({ versions: remaining.map(v => v.version) }, 'Rollback complete');
} catch (err) {
  logger.error({ err }, 'Rollback failed');
  process.exitCode = 1;
} finally {
  closeDatabase();
}
