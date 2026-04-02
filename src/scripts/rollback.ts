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

try {
  const applied = getAppliedVersions(db);
  const currentMax = applied.length > 0 ? Math.max(...applied.map(v => v.version)) : 0;

  if (target >= currentMax) {
    logger.info({ current: currentMax, target }, 'Nothing to rollback');
    process.exit(0);
  }

  logger.info({ current: currentMax, target }, 'Rolling back migrations');
  rollbackTo(db, target);

  const remaining = getAppliedVersions(db);
  logger.info({ versions: remaining.map(v => v.version) }, 'Rollback complete');
} catch (err) {
  logger.error({ err }, 'Rollback failed');
  process.exitCode = 1;
} finally {
  closeDatabase();
}
