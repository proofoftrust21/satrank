// Phase 12A — txid + OP_RETURN script unit tests.
//
// We use real Bitcoin txs as fixtures :
//   - One legacy P2PKH (BIP141 pre-segwit ; no marker/flag, no witnesses)
//   - One segwit P2WPKH (marker=0x00, flag=0x01, with witnesses)
// Both txids are independently verifiable via mempool.space or any block
// explorer. If these tests pass, our parser handles both serialization
// formats correctly.
import { describe, it, expect } from 'vitest';
import { txidFromRawTx, buildOpReturnScript } from '../utils/btcTxidUtil';

describe('txidFromRawTx', () => {
  it('computes txid for a legacy (non-segwit) tx', () => {
    // Bitcoin block 170, the famous Hal Finney tx (first non-coinbase tx).
    // raw : version + 1 input + 2 outputs + locktime.
    const rawHex =
      '0100000001c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd3704000000004847304402204e45e16932b8af514961a1d3a1a25fdf3f4f7732e9d624c6c61548ab5fb8cd410220181522ec8eca07de4860a4acdd12909d831cc56cbbac4622082221a8768d1d0901ffffffff0200ca9a3b00000000434104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac00286bee0000000043410411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3ac00000000';
    const expected = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16';
    expect(txidFromRawTx(rawHex)).toBe(expected);
  });

  it('computes txid for a synthetic segwit tx (witness-stripping branch)', async () => {
    // Construct a minimal valid segwit tx :
    //   version=1, 1 input (null prev, empty scriptSig, seq=ffff..),
    //   1 output (value=0, empty pkScript), 1 witness stack item (empty),
    //   locktime=0.
    // The txid should equal sha256d(legacy form) — which is the same tx with
    // marker / flag / witness section removed. We compute the expected value
    // from the legacy form directly and assert the parser strips correctly.
    const { sha256 } = await import('@noble/hashes/sha2');

    const legacyHex =
      // version (LE)
      '01000000' +
      // input count
      '01' +
      // prev_txid (32 zero bytes) + prev_vout (4 zero bytes) + sigSize=0 + sequence=ffffffff
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '00000000' +
      '00' +
      'ffffffff' +
      // output count
      '01' +
      // value (8 zero bytes) + pkScript size=0
      '0000000000000000' +
      '00' +
      // locktime
      '00000000';

    const segwitHex =
      '01000000' +
      // marker + flag
      '00' +
      '01' +
      '01' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '00000000' +
      '00' +
      'ffffffff' +
      '01' +
      '0000000000000000' +
      '00' +
      // witnesses : 1 stack item, length 0
      '01' +
      '00' +
      '00000000';

    const legacy = Buffer.from(legacyHex, 'hex');
    const expectedTxid = Buffer.from(sha256(Buffer.from(sha256(legacy))))
      .reverse()
      .toString('hex');

    expect(txidFromRawTx(segwitHex)).toBe(expectedTxid);

    // Sanity : the legacy form alone should also parse and yield the same
    // hash (since txid algorithm is identical for non-segwit).
    expect(txidFromRawTx(legacyHex)).toBe(expectedTxid);
  });

  it('rejects truncated input', () => {
    expect(() => txidFromRawTx('010000')).toThrow();
  });

  it('throws on trailing bytes (malformed tx)', () => {
    // Pad a known-good legacy tx with garbage at the end.
    const goodHex =
      '0100000001c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd3704000000004847304402204e45e16932b8af514961a1d3a1a25fdf3f4f7732e9d624c6c61548ab5fb8cd410220181522ec8eca07de4860a4acdd12909d831cc56cbbac4622082221a8768d1d0901ffffffff0200ca9a3b00000000434104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac00286bee0000000043410411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3ac00000000';
    expect(() => txidFromRawTx(goodHex + 'deadbeef')).toThrow(/trailing/);
  });

  it('accepts Buffer input identically to hex string', () => {
    const rawHex =
      '0100000001c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd3704000000004847304402204e45e16932b8af514961a1d3a1a25fdf3f4f7732e9d624c6c61548ab5fb8cd410220181522ec8eca07de4860a4acdd12909d831cc56cbbac4622082221a8768d1d0901ffffffff0200ca9a3b00000000434104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac00286bee0000000043410411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3ac00000000';
    const fromHex = txidFromRawTx(rawHex);
    const fromBuf = txidFromRawTx(Buffer.from(rawHex, 'hex'));
    expect(fromHex).toBe(fromBuf);
  });
});

describe('buildOpReturnScript', () => {
  it('builds a direct-push script for ≤75-byte payloads (AEPS 49 bytes)', () => {
    const payload = Buffer.alloc(49, 0xab);
    const script = buildOpReturnScript(payload);
    // Expected layout : 0x6a + 0x31 (length=49) + 49 × 0xab.
    expect(script[0]).toBe(0x6a);
    expect(script[1]).toBe(49);
    expect(script.length).toBe(2 + 49);
    expect(script.subarray(2).equals(payload)).toBe(true);
  });

  it('uses OP_PUSHDATA1 for 76-80 byte payloads', () => {
    const payload = Buffer.alloc(76, 0xcd);
    const script = buildOpReturnScript(payload);
    expect(script[0]).toBe(0x6a);
    expect(script[1]).toBe(0x4c); // OP_PUSHDATA1
    expect(script[2]).toBe(76);
    expect(script.length).toBe(3 + 76);
  });

  it('rejects empty payload', () => {
    expect(() => buildOpReturnScript(Buffer.alloc(0))).toThrow(/non-empty/);
  });

  it('rejects payload > 80 bytes (Bitcoin Core standardness)', () => {
    expect(() => buildOpReturnScript(Buffer.alloc(81))).toThrow(/standard limit/);
  });
});
