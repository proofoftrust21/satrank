// Worker-threads parallel NIP-13 miner. Used by scripts that publish kind 0
// to nos.lol (28-bit gate observed since 2026-04-09). Single-thread on
// Hetzner CPX42 alpine clocks ~447 k attempts/s for sha256, so 28 bits
// (~268 M expected attempts) needs ~10 minutes. Sharding across N workers
// brings that to ~10/N minutes; 4 vCPUs → ~2.5 min. The mining algorithm
// matches src/nostr/pow.ts byte-for-byte (same canonical serialization,
// same nonce-tag shape) so a freshly-signed event from this miner verifies
// identically downstream.
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ParallelMineInput {
  template: { kind: number; created_at: number; tags: string[][]; content: string };
  pubkey: string;
  targetBits: number;
  maxMs: number;
  workers?: number;
}

export interface ParallelMineResult {
  template: ParallelMineInput['template'];
  attempts: number;
  achievedBits: number;
  elapsedMs: number;
  workerWon: number;
}

function workerFile(): string {
  // The worker file lives next to this module. tsx compiles ts→js on the
  // fly, so the .ts path is acceptable as the worker entry.
  const here = typeof __dirname === 'string'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, 'mineParallelWorker.ts');
}

export async function mineParallel(input: ParallelMineInput): Promise<ParallelMineResult | null> {
  const workerCount = Math.max(1, input.workers ?? Math.max(1, cpus().length));
  const start = Date.now();
  const winnerPromise = new Promise<ParallelMineResult | null>((resolve) => {
    const workers: Worker[] = [];
    let resolved = false;
    const cleanup = (): void => { for (const w of workers) { w.terminate().catch(() => undefined); } };

    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(workerFile(), {
        workerData: {
          template: input.template,
          pubkey: input.pubkey,
          targetBits: input.targetBits,
          maxMs: input.maxMs,
          shardId: i,
          shardCount: workerCount,
        },
        execArgv: ['--import', 'tsx/esm'],
      });
      workers.push(w);
      w.once('message', (msg: ParallelMineResult & { ok: boolean }) => {
        if (resolved) return;
        if (msg.ok) {
          resolved = true;
          cleanup();
          resolve({
            template: msg.template,
            attempts: msg.attempts,
            achievedBits: msg.achievedBits,
            elapsedMs: Date.now() - start,
            workerWon: i,
          });
        }
      });
      w.once('error', () => {
        if (resolved) return;
        // One worker dying is non-fatal — others continue. Only resolve
        // null when all have exited without success.
      });
    }

    // Time-budget watchdog: if no worker has reported success after maxMs,
    // resolve null so the caller can decide whether to retry.
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(null);
    }, input.maxMs + 1000);
    timer.unref?.();
  });
  return winnerPromise;
}
