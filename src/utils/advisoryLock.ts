// File-based advisory lock used to serialize bulk rescore runs across
// processes (crawler + manual scripts). The lock lives next to the DB
// on the same volume so both containers and the host see it.
//
// Semantics:
// - Atomic create-if-not-exists via `openSync(path, 'wx')`. Two writers
//   racing on the same filesystem can only see one succeed.
// - Stale locks (older than `maxStaleMs`, default 10 min) are reclaimed
//   automatically — protects against a crashed process leaving the lock
//   behind. 10 min is comfortably larger than a real bulk rescore
//   (~140s observed for 10k agents) and smaller than any operational
//   interval that would legitimately keep the lock held.
// - `release()` is idempotent; safe to call in a `finally` block.
import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { logger } from '../logger';

export interface AdvisoryLockHandle {
  release: () => void;
}

export function acquireBulkRescoreLock(
  lockPath: string,
  maxStaleMs: number = 10 * 60 * 1000,
): AdvisoryLockHandle | null {
  try {
    const stat = statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > maxStaleMs) {
      logger.warn({ lockPath, ageMs }, 'Reclaiming stale bulk-rescore lock');
      try { unlinkSync(lockPath); } catch { /* race: another reclaimer won */ }
    }
  } catch {
    // Lock file doesn't exist — proceed to create.
  }

  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return null;
    throw err;
  }

  try {
    writeSync(fd, `pid=${process.pid} ts=${Date.now()}\n`);
  } finally {
    closeSync(fd);
  }

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try { unlinkSync(lockPath); } catch { /* already gone */ }
    },
  };
}
