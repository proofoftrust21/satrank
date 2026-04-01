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

  db = new Database(config.DB_PATH);

  // SQLite performance optimizations
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

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
