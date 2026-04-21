// Purge all data from all tables (preserves schema)
// Usage: npm run purge
import { getPool, closePools } from './connection';
import { runMigrations } from './migrations';
import { logger } from '../logger';

async function main(): Promise<void> {
  const pool = getPool();
  await runMigrations(pool);

  await pool.query(`
    DELETE FROM score_snapshots;
    DELETE FROM attestations;
    DELETE FROM transactions;
    DELETE FROM agents;
  `);

  logger.info('All tables purged (agents, transactions, attestations, score_snapshots)');

  await closePools();
}

main().catch((err) => {
  logger.error({ err }, 'purge failed');
  process.exit(1);
});
