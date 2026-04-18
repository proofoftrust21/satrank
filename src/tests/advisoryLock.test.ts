import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireBulkRescoreLock } from '../utils/advisoryLock';

describe('acquireBulkRescoreLock', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'satrank-lock-'));
    lockPath = join(dir, '.bulk-rescore.lock');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires a lock when the file does not exist', () => {
    const handle = acquireBulkRescoreLock(lockPath);
    expect(handle).not.toBeNull();
    expect(() => statSync(lockPath)).not.toThrow();
    handle!.release();
    expect(() => statSync(lockPath)).toThrow();
  });

  it('returns null when the lock is already held by another holder', () => {
    const first = acquireBulkRescoreLock(lockPath);
    expect(first).not.toBeNull();
    const second = acquireBulkRescoreLock(lockPath);
    expect(second).toBeNull();
    first!.release();
    const third = acquireBulkRescoreLock(lockPath);
    expect(third).not.toBeNull();
    third!.release();
  });

  it('reclaims a stale lock past maxStaleMs', () => {
    writeFileSync(lockPath, 'pid=999 ts=0\n');
    const staleTime = new Date(Date.now() - 30 * 60 * 1000);
    utimesSync(lockPath, staleTime, staleTime);

    const handle = acquireBulkRescoreLock(lockPath, 10 * 60 * 1000);
    expect(handle).not.toBeNull();
    handle!.release();
  });

  it('does not reclaim a fresh lock', () => {
    writeFileSync(lockPath, 'pid=999 ts=0\n');
    const handle = acquireBulkRescoreLock(lockPath, 10 * 60 * 1000);
    expect(handle).toBeNull();
  });

  it('release is idempotent', () => {
    const handle = acquireBulkRescoreLock(lockPath);
    expect(handle).not.toBeNull();
    handle!.release();
    expect(() => handle!.release()).not.toThrow();
  });
});
