// Worker entry — paired with mineParallel.ts. Each shard sweeps a
// distinct slice of the nonce space (`shardId, shardId+shardCount,
// shardId+2*shardCount, …`) so two workers never test the same input.
import { parentPort, workerData } from 'node:worker_threads';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

interface WorkerInput {
  template: { kind: number; created_at: number; tags: string[][]; content: string };
  pubkey: string;
  targetBits: number;
  maxMs: number;
  shardId: number;
  shardCount: number;
}

const data = workerData as WorkerInput;

function leadingZeroBits(hex: string): number {
  let bits = 0;
  for (let i = 0; i < hex.length; i++) {
    const nibble = parseInt(hex[i], 16);
    if (nibble === 0) { bits += 4; continue; }
    if (nibble < 2) return bits + 3;
    if (nibble < 4) return bits + 2;
    if (nibble < 8) return bits + 1;
    return bits;
  }
  return bits;
}

function serializeForId(pubkey: string, ev: WorkerInput['template']): string {
  return JSON.stringify([0, pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
}

const baseTags = data.template.tags.filter((t) => t[0] !== 'nonce');
const start = Date.now();
const nonceTag = ['nonce', '0', String(data.targetBits)];
const tags = [...baseTags, nonceTag];
const candidate = {
  kind: data.template.kind,
  created_at: data.template.created_at,
  tags,
  content: data.template.content,
};

let nonce = data.shardId;
const stride = data.shardCount;
const BUDGET_CHECK = 4096;
let local = 0;

while (true) {
  nonceTag[1] = nonce.toString();
  const id = bytesToHex(sha256(serializeForId(data.pubkey, candidate)));
  const bits = leadingZeroBits(id);
  if (bits >= data.targetBits) {
    parentPort!.postMessage({
      ok: true,
      template: { ...candidate, tags: [...candidate.tags] },
      attempts: nonce,
      achievedBits: bits,
      elapsedMs: Date.now() - start,
    });
    return;
  }
  nonce += stride;
  local++;
  if ((local & (BUDGET_CHECK - 1)) === 0) {
    if (Date.now() - start >= data.maxMs) {
      parentPort!.postMessage({ ok: false, attempts: nonce, achievedBits: 0, elapsedMs: Date.now() - start, template: candidate });
      return;
    }
  }
}
