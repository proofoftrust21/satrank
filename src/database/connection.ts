// Singleton SQLite connection with better-sqlite3
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../logger';

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (db) return db;

  // Create data/ directory if needed
  const dbDir = path.dirname(config.DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(config.DB_PATH, { timeout: 15_000 });

  // SQLite performance & concurrency
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  // busy_timeout lets writers wait up to 15s on a locked DB instead of throwing
  // SQLITE_BUSY immediately. WAL already allows concurrent readers; this covers
  // the writer-on-writer case that surfaces under concurrent /api/best-route
  // pathfinding batches (sim #9 FINDING #3).
  db.pragma('busy_timeout = 15000');
  db.pragma('wal_autocheckpoint = 1000');

  logger.info({ path: config.DB_PATH }, 'Database connected');
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database closed');
  }
}
