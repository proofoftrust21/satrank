// Backup data/satrank.db → data/backups/satrank-{timestamp}.db
// Keeps the 24 most recent backups, deletes older ones.
// Verifies backup integrity with PRAGMA integrity_check after copy.
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { config } from '../config';
import { logger } from '../logger';

const MAX_BACKUPS = 24;

function run(): void {
  const dbPath = path.resolve(config.DB_PATH);
  if (!fs.existsSync(dbPath)) {
    logger.error({ dbPath }, 'Database file not found');
    process.exit(1);
  }

  const backupDir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  // Create backup with ISO timestamp (filesystem-safe)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `satrank-${timestamp}.db`;
  const backupPath = path.join(backupDir, backupName);

  fs.copyFileSync(dbPath, backupPath);

  // Verify backup integrity
  try {
    const backupDb = new Database(backupPath, { readonly: true });
    const result = backupDb.pragma('integrity_check') as { integrity_check: string }[];
    backupDb.close();

    const status = result[0]?.integrity_check;
    if (status !== 'ok') {
      logger.error({ backupPath, status }, 'Backup integrity check failed — removing corrupt backup');
      fs.unlinkSync(backupPath);
      process.exit(1);
    }
  } catch (err) {
    logger.error({ backupPath, err }, 'Backup integrity check error — removing corrupt backup');
    fs.unlinkSync(backupPath);
    process.exit(1);
  }

  logger.info({ backupPath }, 'Backup created and verified');

  // Prune old backups — keep only the most recent MAX_BACKUPS
  const backups = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('satrank-') && f.endsWith('.db'))
    .sort()
    .reverse();

  const toDelete = backups.slice(MAX_BACKUPS);
  for (const file of toDelete) {
    const filePath = path.join(backupDir, file);
    fs.unlinkSync(filePath);
    logger.info({ file }, 'Old backup deleted');
  }

  logger.info({ total: Math.min(backups.length, MAX_BACKUPS), deleted: toDelete.length }, 'Backup complete');
}

run();
