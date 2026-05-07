// AEPS conformance — TypeScript impl reads spec/test-vectors/*.json and
// asserts identical output to the Rust impl (which reads the same fixtures
// in apps/aeps-node-rs/tests/conformance.rs).
//
// If a vector fails here, either the TS impl has a bug, OR the spec is
// ambiguous and the Rust impl will also fail. In the latter case the spec
// must be clarified before adjusting either impl.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { merkleRoot } from '../services/merkleTreeUtil';
import { buildOpReturnPayload } from '../services/dailyMerkleAnchorService';
import {
  buildOutcomeMessage,
  buildOutcomeMessageHash,
} from '../services/disputeService';

const VECTORS_DIR = join(__dirname, '..', '..', 'spec', 'test-vectors');

interface MerkleVector {
  name: string;
  leaves_hex: string[];
  expected_root_hex: string;
}

interface OpReturnVector {
  name: string;
  operator_pubkey_hex: string;
  day_utc: string;
  root_hex: string;
  expected_payload_hex: string;
}

interface MerkleFixture {
  vectors: MerkleVector[];
}

interface OpReturnFixture {
  vectors: OpReturnVector[];
}

function loadFixture<T>(filename: string): T {
  return JSON.parse(readFileSync(join(VECTORS_DIR, filename), 'utf8')) as T;
}

describe('AEPS conformance — RFC 6962 Merkle root', () => {
  const fixture = loadFixture<MerkleFixture>('merkle.json');

  for (const vector of fixture.vectors) {
    it(vector.name, () => {
      const leaves = vector.leaves_hex.map(h => Buffer.from(h, 'hex'));
      const root = merkleRoot(leaves);
      expect(root.toString('hex')).toBe(vector.expected_root_hex);
    });
  }
});

describe('AEPS conformance — §8.3 OP_RETURN payload', () => {
  const fixture = loadFixture<OpReturnFixture>('op_return.json');

  for (const vector of fixture.vectors) {
    it(vector.name, () => {
      const payload = buildOpReturnPayload(
        vector.operator_pubkey_hex,
        vector.day_utc,
        vector.root_hex,
      );
      expect(payload.toString('hex')).toBe(vector.expected_payload_hex);
    });
  }
});

interface DisputeOutcomeVector {
  name: string;
  dispute_id: string;
  outcome: 'disputant_wins' | 'respondent_wins';
  expected_canonical: string;
  expected_hash_hex: string;
}

interface DisputeOutcomeFixture {
  vectors: DisputeOutcomeVector[];
}

describe('AEPS conformance — §10 canonical outcome message', () => {
  const fixture = loadFixture<DisputeOutcomeFixture>('dispute_outcome.json');

  for (const vector of fixture.vectors) {
    it(vector.name, () => {
      const canonical = buildOutcomeMessage(vector.dispute_id, vector.outcome);
      expect(canonical).toBe(vector.expected_canonical);
      const hash = buildOutcomeMessageHash(vector.dispute_id, vector.outcome);
      expect(hash.toString('hex')).toBe(vector.expected_hash_hex);
    });
  }
});
