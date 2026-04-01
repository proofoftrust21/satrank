// Purge all data from all tables (preserves schema)
// Usage: npm run purge
import { getDatabase, closeDatabase } from './connection';
import { runMigrations } from './migrations';
import { logger } from '../logger';

const db = getDatabase();
runMigrations(db);

db.exec(`
  DELETE FROM score_snapshots;
  DELETE FROM attestations;
  DELETE FROM transactions;
  DELETE FROM agents;
`);

logger.info('All tables purged (agents, transactions, attestations, score_snapshots)');

closeDatabase();
