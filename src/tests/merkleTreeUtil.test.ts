// AEPS §8 — RFC 6962 Merkle tree primitives tests.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  leafHash,
  nodeHash,
  emptyRoot,
  largestPowerOfTwoLessThan,
  merkleRoot,
  inclusionProof,
  verifyInclusionProof,
} from '../services/merkleTreeUtil';

function leaves(...hexes: string[]): Buffer[] {
  return hexes.map(h => Buffer.from(h, 'hex'));
}

describe('AEPS §8 — Merkle tree primitives', () => {
  describe('largestPowerOfTwoLessThan', () => {
    it('rejects n < 2', () => {
      expect(() => largestPowerOfTwoLessThan(1)).toThrow();
      expect(() => largestPowerOfTwoLessThan(0)).toThrow();
    });

    it('returns 1 for n=2', () => {
      expect(largestPowerOfTwoLessThan(2)).toBe(1);
    });

    it('returns 2 for n=3,4', () => {
      expect(largestPowerOfTwoLessThan(3)).toBe(2);
      expect(largestPowerOfTwoLessThan(4)).toBe(2);
    });

    it('returns 4 for n=5..8', () => {
      expect(largestPowerOfTwoLessThan(5)).toBe(4);
      expect(largestPowerOfTwoLessThan(8)).toBe(4);
    });

    it('returns 8 for n=9..16', () => {
      expect(largestPowerOfTwoLessThan(9)).toBe(8);
      expect(largestPowerOfTwoLessThan(16)).toBe(8);
    });
  });

  describe('emptyRoot', () => {
    it('matches SHA-256("")', () => {
      const expected = createHash('sha256').update(Buffer.alloc(0)).digest();
      expect(emptyRoot().equals(expected)).toBe(true);
    });
  });

  describe('leafHash / nodeHash', () => {
    it('leafHash applies 0x00 prefix', () => {
      const data = Buffer.from('aabbcc', 'hex');
      const expected = createHash('sha256')
        .update(Buffer.concat([Buffer.from([0x00]), data]))
        .digest();
      expect(leafHash(data).equals(expected)).toBe(true);
    });

    it('nodeHash applies 0x01 prefix and concatenation order', () => {
      const l = Buffer.from('11'.repeat(32), 'hex');
      const r = Buffer.from('22'.repeat(32), 'hex');
      const expected = createHash('sha256')
        .update(Buffer.concat([Buffer.from([0x01]), l, r]))
        .digest();
      expect(nodeHash(l, r).equals(expected)).toBe(true);
    });
  });

  describe('merkleRoot', () => {
    it('empty list = SHA-256("")', () => {
      expect(merkleRoot([]).equals(emptyRoot())).toBe(true);
    });

    it('single leaf = leafHash(leaf)', () => {
      const data = Buffer.from('deadbeef', 'hex');
      expect(merkleRoot([data]).equals(leafHash(data))).toBe(true);
    });

    it('two leaves = nodeHash(leafHash(d0), leafHash(d1))', () => {
      const d0 = Buffer.from('aa', 'hex');
      const d1 = Buffer.from('bb', 'hex');
      const expected = nodeHash(leafHash(d0), leafHash(d1));
      expect(merkleRoot([d0, d1]).equals(expected)).toBe(true);
    });

    it('three leaves: split = (2,1)', () => {
      const d0 = Buffer.from('aa', 'hex');
      const d1 = Buffer.from('bb', 'hex');
      const d2 = Buffer.from('cc', 'hex');
      // k=2, left=mth([d0,d1]), right=mth([d2])
      const left = nodeHash(leafHash(d0), leafHash(d1));
      const right = leafHash(d2);
      const expected = nodeHash(left, right);
      expect(merkleRoot([d0, d1, d2]).equals(expected)).toBe(true);
    });

    it('deterministic: same leaves → same root', () => {
      const ls = leaves('11', '22', '33', '44', '55');
      const a = merkleRoot(ls);
      const b = merkleRoot(ls.slice());
      expect(a.equals(b)).toBe(true);
    });

    it('changing any leaf changes the root', () => {
      const ls1 = leaves('11', '22', '33', '44');
      const ls2 = leaves('11', '22', '33', '45'); // last leaf differs
      expect(merkleRoot(ls1).equals(merkleRoot(ls2))).toBe(false);
    });
  });

  describe('inclusionProof + verifyInclusionProof roundtrip', () => {
    it('single-leaf tree has empty proof and verifies', () => {
      const leaf = Buffer.from('aabb', 'hex');
      const root = merkleRoot([leaf]);
      const proof = inclusionProof([leaf], 0);
      expect(proof.length).toBe(0);
      expect(verifyInclusionProof(leaf, 0, 1, proof, root)).toBe(true);
    });

    it('two-leaf tree: proof length 1', () => {
      const ls = leaves('aa', 'bb');
      const root = merkleRoot(ls);
      for (let i = 0; i < 2; i++) {
        const p = inclusionProof(ls, i);
        expect(p.length).toBe(1);
        expect(verifyInclusionProof(ls[i], i, 2, p, root)).toBe(true);
      }
    });

    it('roundtrip for tree size n in [1..17]', () => {
      for (let n = 1; n <= 17; n++) {
        const ls: Buffer[] = [];
        for (let i = 0; i < n; i++) {
          ls.push(Buffer.from([i, (i * 31) & 0xff, (i * 7 + 13) & 0xff]));
        }
        const root = merkleRoot(ls);
        for (let i = 0; i < n; i++) {
          const proof = inclusionProof(ls, i);
          const ok = verifyInclusionProof(ls[i], i, n, proof, root);
          if (!ok) {
            throw new Error(`verification failed for n=${n} i=${i}`);
          }
        }
      }
    });

    it('rejects wrong leaf', () => {
      const ls = leaves('aa', 'bb', 'cc');
      const root = merkleRoot(ls);
      const proof = inclusionProof(ls, 1);
      const wrongLeaf = Buffer.from('ff', 'hex');
      expect(verifyInclusionProof(wrongLeaf, 1, 3, proof, root)).toBe(false);
    });

    it('rejects wrong index', () => {
      const ls = leaves('aa', 'bb', 'cc');
      const root = merkleRoot(ls);
      const proof = inclusionProof(ls, 1);
      expect(verifyInclusionProof(ls[1], 0, 3, proof, root)).toBe(false);
    });

    it('rejects wrong tree size when path length differs', () => {
      // n=3 produces a length-2 path for index 1; n=8 expects length-3 for the
      // same index. RFC 6962 only catches mismatched-treeSize when path lengths
      // diverge — protocol-level non-equivocation comes from the L1 STH, not
      // this verifier in isolation. Picking treeSize=8 guarantees rejection.
      const ls = leaves('aa', 'bb', 'cc');
      const root = merkleRoot(ls);
      const proof = inclusionProof(ls, 1);
      expect(verifyInclusionProof(ls[1], 1, 8, proof, root)).toBe(false);
    });

    it('rejects truncated proof', () => {
      const ls = leaves('aa', 'bb', 'cc', 'dd');
      const root = merkleRoot(ls);
      const proof = inclusionProof(ls, 2);
      expect(verifyInclusionProof(ls[2], 2, 4, proof.slice(0, 1), root)).toBe(false);
    });

    it('rejects proof against wrong root', () => {
      const ls = leaves('aa', 'bb', 'cc');
      const proof = inclusionProof(ls, 0);
      const wrongRoot = Buffer.from('00'.repeat(32), 'hex');
      expect(verifyInclusionProof(ls[0], 0, 3, proof, wrongRoot)).toBe(false);
    });

    it('rejects index out of range', () => {
      const ls = leaves('aa', 'bb');
      const root = merkleRoot(ls);
      expect(verifyInclusionProof(ls[0], -1, 2, [], root)).toBe(false);
      expect(verifyInclusionProof(ls[0], 5, 2, [], root)).toBe(false);
    });

    it('inclusion proof for index out of range throws', () => {
      const ls = leaves('aa', 'bb');
      expect(() => inclusionProof(ls, -1)).toThrow();
      expect(() => inclusionProof(ls, 2)).toThrow();
    });
  });
});
