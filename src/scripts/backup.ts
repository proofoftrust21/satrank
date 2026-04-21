// Phase 12B — pg_dump based backup.
// Emits `pg_dump $DATABASE_URL | gzip > backups/satrank-YYYYMMDD-HHMMSS.sql.gz`
// Keeps the 24 most recent backups. Runs pg_dump as a streaming pipeline so
// the dump never has to fit in memory.
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { config } from '../config';
import { logger } from '../logger';

const MAX_BACKUPS = 24;

function timestamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const yyyy = now.getUTCFullYear();
  const mm = pad(now.getUTCMonth() + 1);
  const dd = pad(now.getUTCDate());
  const hh = pad(now.getUTCHours());
  const mi = pad(now.getUTCMinutes());
  const ss = pad(now.getUTCSeconds());
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

async function main(): Promise<void> {
  const backupDir = path.resolve('backups');
  fs.mkdirSync(backupDir, { recursive: true });

  const backupName = `satrank-${timestamp()}.sql.gz`;
  const backupPath = path.join(backupDir, backupName);

  // pg_dump → gzip → file. Use spawn so we can wire the stdout stream
  // through createGzip() into a file without buffering the whole dump.
  const dump = spawn('pg_dump', [config.DATABASE_URL], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrBuf = '';
  dump.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
  });

  const out = fs.createWriteStream(backupPath);
  const gzip = createGzip();

  try {
    await Promise.all([
      pipeline(dump.stdout, gzip, out),
      new Promise<void>((resolve, reject) => {
        dump.on('error', reject);
        dump.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`pg_dump exited with code ${code}: ${stderrBuf.trim()}`));
          }
        });
      }),
    ]);
  } catch (err) {
    // Remove a partial dump so we never keep a truncated backup on disk.
    try {
      fs.unlinkSync(backupPath);
    } catch {
      // best-effort
    }
    logger.error({ err, backupPath }, 'pg_dump failed — partial backup removed');
    process.exit(1);
  }

  const { size } = fs.statSync(backupPath);
  logger.info({ backupPath, bytes: size }, 'Backup created');

  // Prune old backups — keep only the most recent MAX_BACKUPS
  const backups = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith('satrank-') && f.endsWith('.sql.gz'))
    .sort()
    .reverse();

  const toDelete = backups.slice(MAX_BACKUPS);
  for (const file of toDelete) {
    const filePath = path.join(backupDir, file);
    fs.unlinkSync(filePath);
    logger.info({ file }, 'Old backup deleted');
  }

  logger.info(
    { total: Math.min(backups.length, MAX_BACKUPS), deleted: toDelete.length },
    'Backup complete',
  );
}

main().catch((err) => {
  logger.error({ err }, 'backup failed');
  process.exit(1);
});
