// AEPS §8.2 — RFC 6962 Merkle tree primitives.
//
// Pure functions, no I/O. Used by DailyMerkleAnchorService to construct the
// daily root over evidence_receipts and to generate inclusion proofs.
//
// Why RFC 6962 and not Bitcoin-Merkle: RFC 6962 prefixes leaf and node hashes
// (0x00 / 0x01) which prevents the second-preimage attack present in
// Bitcoin's tx-Merkle. Verification libs are universal (Certificate
// Transparency, Sigstore-Rekor).
//
// Reference: RFC 6962-bis, section 2.1.
import { createHash } from 'node:crypto';

const PREFIX_LEAF = Buffer.from([0x00]);
const PREFIX_NODE = Buffer.from([0x01]);

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

export function leafHash(leaf: Buffer): Buffer {
  return sha256(Buffer.concat([PREFIX_LEAF, leaf]));
}

export function nodeHash(left: Buffer, right: Buffer): Buffer {
  return sha256(Buffer.concat([PREFIX_NODE, left, right]));
}

/** Empty Merkle root = SHA-256 of empty input (RFC 6962 §2.1). */
export function emptyRoot(): Buffer {
  return sha256(Buffer.alloc(0));
}

/** Largest power of two strictly less than n (RFC 6962 split point). */
export function largestPowerOfTwoLessThan(n: number): number {
  if (n <= 1) throw new Error(`largestPowerOfTwoLessThan requires n>=2, got ${n}`);
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** RFC 6962 Merkle Tree Hash over an ordered list of leaves. */
export function merkleRoot(leaves: ReadonlyArray<Buffer>): Buffer {
  if (leaves.length === 0) return emptyRoot();
  if (leaves.length === 1) return leafHash(leaves[0]);
  const k = largestPowerOfTwoLessThan(leaves.length);
  const left = merkleRoot(leaves.slice(0, k));
  const right = merkleRoot(leaves.slice(k));
  return nodeHash(left, right);
}

/** Bottom-up audit path for the leaf at `leafIndex` in `leaves`. RFC 6962 §2.1.1.
 *  First entry is sibling at leaf level; last entry is sibling near root. */
export function inclusionProof(leaves: ReadonlyArray<Buffer>, leafIndex: number): Buffer[] {
  if (leafIndex < 0 || leafIndex >= leaves.length) {
    throw new Error(`leafIndex ${leafIndex} out of range [0, ${leaves.length})`);
  }
  if (leaves.length === 1) return [];
  return pathRecursive(leaves, leafIndex);
}

function pathRecursive(D: ReadonlyArray<Buffer>, m: number): Buffer[] {
  const n = D.length;
  if (n === 1) return [];
  const k = largestPowerOfTwoLessThan(n);
  if (m < k) {
    return [...pathRecursive(D.slice(0, k), m), merkleRoot(D.slice(k))];
  }
  return [...pathRecursive(D.slice(k), m - k), merkleRoot(D.slice(0, k))];
}

/** Verify an audit path against an expected root. RFC 6962-bis §2.1.3.2. */
export function verifyInclusionProof(
  leaf: Buffer,
  leafIndex: number,
  treeSize: number,
  auditPath: ReadonlyArray<Buffer>,
  rootHash: Buffer,
): boolean {
  if (treeSize <= 0 || leafIndex < 0 || leafIndex >= treeSize) return false;

  let fn = leafIndex;
  let sn = treeSize - 1;
  let r = leafHash(leaf);

  for (const p of auditPath) {
    if (sn === 0) return false;

    if ((fn & 1) === 1 || fn === sn) {
      r = nodeHash(p, r);
      if ((fn & 1) === 0) {
        while ((fn & 1) === 0 && fn !== 0) {
          fn >>>= 1;
          sn >>>= 1;
        }
      }
    } else {
      r = nodeHash(r, p);
    }

    fn >>>= 1;
    sn >>>= 1;
  }

  return sn === 0 && r.equals(rootHash);
}

/** Hex helpers for clean serialization in API + DB. */
export function rootHex(root: Buffer): string {
  return root.toString('hex');
}

export function pathHex(path: ReadonlyArray<Buffer>): string[] {
  return path.map(b => b.toString('hex'));
}

export function pathFromHex(hexes: ReadonlyArray<string>): Buffer[] {
  return hexes.map(h => Buffer.from(h, 'hex'));
}
