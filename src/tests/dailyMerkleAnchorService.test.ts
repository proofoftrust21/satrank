// AEPS §8 — DailyMerkleAnchorService unit tests.
import { describe, it, expect } from 'vitest';
import {
  receiptsToLeaves,
  leafForReceipt,
  utcDayBounds,
  unixSecToUtcDay,
  buildOpReturnPayload,
} from '../services/dailyMerkleAnchorService';
import { merkleRoot, leafHash, rootHex } from '../services/merkleTreeUtil';

describe('AEPS §8 — DailyMerkleAnchorService helpers', () => {
  describe('receiptsToLeaves', () => {
    it('returns hex-decoded payload_sha256 buffers in order', () => {
      const receipts = [
        { receipt_id: 1, payload_sha256: 'aa'.repeat(32), signed_at: 100 },
        { receipt_id: 2, payload_sha256: 'bb'.repeat(32), signed_at: 200 },
      ];
      const leaves = receiptsToLeaves(receipts);
      expect(leaves).toHaveLength(2);
      expect(leaves[0].toString('hex')).toBe('aa'.repeat(32));
      expect(leaves[1].toString('hex')).toBe('bb'.repeat(32));
    });

    it('preserves order of input', () => {
      const receipts = [
        { receipt_id: 5, payload_sha256: '11'.repeat(32), signed_at: 100 },
        { receipt_id: 3, payload_sha256: '22'.repeat(32), signed_at: 50 },
        { receipt_id: 8, payload_sha256: '33'.repeat(32), signed_at: 150 },
      ];
      const leaves = receiptsToLeaves(receipts);
      expect(leaves[0].toString('hex')).toBe('11'.repeat(32));
      expect(leaves[1].toString('hex')).toBe('22'.repeat(32));
      expect(leaves[2].toString('hex')).toBe('33'.repeat(32));
    });
  });

  describe('leafForReceipt', () => {
    it('hashes payload_sha256 buffer with 0x00 prefix per RFC 6962', () => {
      const r = { payload_sha256: 'cd'.repeat(32) };
      const expected = leafHash(Buffer.from('cd'.repeat(32), 'hex'));
      expect(leafForReceipt(r).equals(expected)).toBe(true);
    });
  });

  describe('utcDayBounds', () => {
    it('2026-05-07 = [Date.UTC(2026,4,7), +86400)', () => {
      const { startSec, endSec } = utcDayBounds('2026-05-07');
      expect(startSec).toBe(Math.floor(Date.UTC(2026, 4, 7) / 1000));
      expect(endSec).toBe(startSec + 86400);
    });

    it('rejects malformed date strings', () => {
      expect(() => utcDayBounds('2026-5-7')).toThrow();
      expect(() => utcDayBounds('20260507')).toThrow();
      expect(() => utcDayBounds('not-a-date')).toThrow();
      expect(() => utcDayBounds('')).toThrow();
    });
  });

  describe('unixSecToUtcDay', () => {
    it('2026-05-07 00:00:00 UTC → 2026-05-07', () => {
      const sec = Math.floor(Date.UTC(2026, 4, 7, 0, 0, 0) / 1000);
      expect(unixSecToUtcDay(sec)).toBe('2026-05-07');
    });

    it('2026-05-07 23:59:59 UTC → 2026-05-07', () => {
      const sec = Math.floor(Date.UTC(2026, 4, 7, 23, 59, 59) / 1000);
      expect(unixSecToUtcDay(sec)).toBe('2026-05-07');
    });

    it('round-trip with utcDayBounds', () => {
      const { startSec } = utcDayBounds('2026-12-31');
      expect(unixSecToUtcDay(startSec)).toBe('2026-12-31');
    });
  });

  describe('buildOpReturnPayload', () => {
    it('produces 49-byte payload: tag(5) + op8(8) + day(4) + root(32)', () => {
      const operatorPubkey = 'ab'.repeat(32); // 64 chars
      const dayUtc = '2026-05-07';
      const root = 'cd'.repeat(32);
      const payload = buildOpReturnPayload(operatorPubkey, dayUtc, root);
      expect(payload.length).toBe(49);
      expect(payload.slice(0, 5).toString('utf8')).toBe('AEPS1');
      expect(payload.slice(5, 13).toString('hex')).toBe('ab'.repeat(8));
      // Day 2026-05-07 is 126 days after 2026-01-01 (UTC).
      expect(payload.slice(13, 17).readUInt32LE(0)).toBe(126);
      expect(payload.slice(17).toString('hex')).toBe('cd'.repeat(32));
    });

    it('different days produce different payloads', () => {
      const operatorPubkey = 'aa'.repeat(32);
      const root = 'bb'.repeat(32);
      const a = buildOpReturnPayload(operatorPubkey, '2026-05-07', root);
      const b = buildOpReturnPayload(operatorPubkey, '2026-05-08', root);
      expect(a.equals(b)).toBe(false);
    });

    it('different roots produce different payloads', () => {
      const operatorPubkey = 'aa'.repeat(32);
      const dayUtc = '2026-05-07';
      const a = buildOpReturnPayload(operatorPubkey, dayUtc, 'bb'.repeat(32));
      const b = buildOpReturnPayload(operatorPubkey, dayUtc, 'cc'.repeat(32));
      expect(a.equals(b)).toBe(false);
    });

    it('rejects short root hex', () => {
      const operatorPubkey = 'aa'.repeat(32);
      expect(() => buildOpReturnPayload(operatorPubkey, '2026-05-07', 'bb')).toThrow();
    });
  });

  describe('end-to-end: leaves → root → root_hex matches whitepaper §8.2 invariant', () => {
    it('zero receipts yields the empty-tree root', () => {
      const root = merkleRoot([]);
      // Empty SHA-256
      expect(rootHex(root)).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
    });

    it('single receipt yields leafHash(payload_sha256)', () => {
      const r = { receipt_id: 1, payload_sha256: '11'.repeat(32), signed_at: 100 };
      const leaves = receiptsToLeaves([r]);
      const root = merkleRoot(leaves);
      const expected = leafHash(Buffer.from('11'.repeat(32), 'hex'));
      expect(root.equals(expected)).toBe(true);
    });
  });
});
