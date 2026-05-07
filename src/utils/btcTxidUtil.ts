// Phase 12A (2026-05-07) — minimal Bitcoin tx parser for txid computation.
//
// LND `walletrpc.WalletKit/SendOutputs` returns the broadcast tx as raw bytes
// (segwit-serialized) but no txid. We need the txid for two reasons :
//   1. Persist into `daily_merkle_anchors.l1_txid` so the API layer can hand
//      it back to verifiers.
//   2. Tag the kind 31403 Nostr gossip event so consumers can fetch the L1 tx
//      without us.
//
// Bitcoin txid algorithm :
//   txid = SHA-256( SHA-256( legacy_serialization(tx) ) ).reverse()
//
// "Legacy serialization" means : version || inputs || outputs || locktime —
// witness data + the segwit marker/flag are stripped. For non-segwit txs the
// raw bytes ARE the legacy serialization.
//
// This file does the minimum needed to detect segwit + strip witnesses ; it
// does NOT validate scripts or amounts. Callers feed it bytes that LND signed
// and broadcast — we trust the structure.
import { sha256 } from '@noble/hashes/sha2';

const SEGWIT_MARKER = 0x00;
const SEGWIT_FLAG = 0x01;

interface Cursor {
  buf: Buffer;
  pos: number;
}

function readUInt8(c: Cursor): number {
  const v = c.buf.readUInt8(c.pos);
  c.pos += 1;
  return v;
}

function readUInt32LE(c: Cursor): number {
  const v = c.buf.readUInt32LE(c.pos);
  c.pos += 4;
  return v;
}

function readBytes(c: Cursor, n: number): Buffer {
  const out = c.buf.subarray(c.pos, c.pos + n);
  c.pos += n;
  return out;
}

/** Bitcoin varint : 0xfd ⇒ next 2 bytes (uint16 LE), 0xfe ⇒ next 4 (uint32 LE),
 *  0xff ⇒ next 8 (uint64 LE) — for our use we cap at uint32 since tx components
 *  never exceed 2^32. */
function readVarInt(c: Cursor): number {
  const first = readUInt8(c);
  if (first < 0xfd) return first;
  if (first === 0xfd) {
    const v = c.buf.readUInt16LE(c.pos);
    c.pos += 2;
    return v;
  }
  if (first === 0xfe) {
    const v = c.buf.readUInt32LE(c.pos);
    c.pos += 4;
    return v;
  }
  // 0xff — uint64. Read low 32 bits ; high 32 bits should be 0 in our context.
  const lo = c.buf.readUInt32LE(c.pos);
  const hi = c.buf.readUInt32LE(c.pos + 4);
  c.pos += 8;
  if (hi !== 0) {
    throw new Error(`varint exceeds uint32 range : hi=${hi}`);
  }
  return lo;
}

function writeVarInt(n: number): Buffer {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const b = Buffer.allocUnsafe(3);
    b.writeUInt8(0xfd, 0);
    b.writeUInt16LE(n, 1);
    return b;
  }
  if (n <= 0xffffffff) {
    const b = Buffer.allocUnsafe(5);
    b.writeUInt8(0xfe, 0);
    b.writeUInt32LE(n, 1);
    return b;
  }
  // We don't expect n > uint32 in tx serialization.
  throw new Error(`varint exceeds uint32 : ${n}`);
}

/** Compute the Bitcoin txid from a raw transaction (hex or Buffer).
 *  Handles both legacy and segwit-serialized txs. Returns lowercase hex. */
export function txidFromRawTx(raw: Buffer | string): string {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'hex');
  if (buf.length < 10) {
    throw new Error(`raw tx too short : ${buf.length} bytes`);
  }

  const c: Cursor = { buf, pos: 0 };

  // version (4 bytes LE).
  const versionStart = c.pos;
  readUInt32LE(c);
  const versionEnd = c.pos;

  // Detect segwit by peeking at marker.
  let isSegwit = false;
  if (c.buf.readUInt8(c.pos) === SEGWIT_MARKER && c.buf.readUInt8(c.pos + 1) === SEGWIT_FLAG) {
    isSegwit = true;
    c.pos += 2; // skip marker + flag
  }

  // Inputs.
  const inputsStart = c.pos;
  const numInputs = readVarInt(c);
  for (let i = 0; i < numInputs; i++) {
    readBytes(c, 32); // prev_txid
    readUInt32LE(c); // prev_vout
    const scriptLen = readVarInt(c);
    readBytes(c, scriptLen); // scriptSig
    readUInt32LE(c); // sequence
  }
  const inputsEnd = c.pos;

  // Outputs.
  const outputsStart = c.pos;
  const numOutputs = readVarInt(c);
  for (let i = 0; i < numOutputs; i++) {
    readBytes(c, 8); // value
    const scriptLen = readVarInt(c);
    readBytes(c, scriptLen); // pkScript
  }
  const outputsEnd = c.pos;

  // Witnesses (segwit only — skipped for legacy serialization).
  if (isSegwit) {
    for (let i = 0; i < numInputs; i++) {
      const stackItems = readVarInt(c);
      for (let j = 0; j < stackItems; j++) {
        const itemLen = readVarInt(c);
        readBytes(c, itemLen);
      }
    }
  }

  // Locktime (4 bytes LE).
  const locktimeStart = c.pos;
  readUInt32LE(c);
  const locktimeEnd = c.pos;

  if (c.pos !== buf.length) {
    throw new Error(`tx parse left ${buf.length - c.pos} trailing bytes — malformed input`);
  }

  // Build legacy-serialized buffer for hashing : version || inputs || outputs
  // || locktime. We slice rather than re-emit to preserve the exact byte forms
  // (varints, scriptSigs) without round-trip risk.
  const legacy = Buffer.concat([
    buf.subarray(versionStart, versionEnd),
    // re-emit inputs varint count + input bodies. The varint numInputs was read
    // from inputsStart ; we just slice [inputsStart, inputsEnd] — same bytes.
    buf.subarray(inputsStart, inputsEnd),
    buf.subarray(outputsStart, outputsEnd),
    buf.subarray(locktimeStart, locktimeEnd),
  ]);

  // Double-SHA256, then reverse for txid display order.
  const hash1 = Buffer.from(sha256(legacy));
  const hash2 = Buffer.from(sha256(hash1));
  return Buffer.from(hash2).reverse().toString('hex');
}

/** Build the OP_RETURN scriptPubKey for a given payload :
 *    OP_RETURN <push> <payload>
 *  Bitcoin Core defaults to a max OP_RETURN data size of 80 bytes.
 *  Push opcode :
 *    - payload.length ≤ 75   → direct push (length byte itself)
 *    - 76 ≤ length ≤ 255     → OP_PUSHDATA1 (0x4c) + length byte
 *    - 256 ≤ length ≤ 65535  → OP_PUSHDATA2 (0x4d) + uint16 LE length
 *  AEPS payload is 49 bytes so the direct-push branch always applies. The
 *  larger branches are kept defensively. */
const OP_RETURN = 0x6a;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const STANDARD_OP_RETURN_DATA_MAX = 80;

export function buildOpReturnScript(payload: Buffer): Buffer {
  if (payload.length === 0) {
    throw new Error('OP_RETURN payload must be non-empty');
  }
  if (payload.length > STANDARD_OP_RETURN_DATA_MAX) {
    throw new Error(`OP_RETURN payload exceeds standard limit : ${payload.length} > ${STANDARD_OP_RETURN_DATA_MAX}`);
  }
  if (payload.length <= 75) {
    return Buffer.concat([Buffer.from([OP_RETURN, payload.length]), payload]);
  }
  if (payload.length <= 255) {
    return Buffer.concat([Buffer.from([OP_RETURN, OP_PUSHDATA1, payload.length]), payload]);
  }
  // payload.length ≤ 80 already enforced above ; this branch is unreachable
  // but kept for completeness should the standard limit ever rise.
  const lenBytes = Buffer.allocUnsafe(2);
  lenBytes.writeUInt16LE(payload.length, 0);
  return Buffer.concat([Buffer.from([OP_RETURN, OP_PUSHDATA2]), lenBytes, payload]);
}

// Re-export writeVarInt for tests / callers building raw txs in unit tests.
export { writeVarInt };
