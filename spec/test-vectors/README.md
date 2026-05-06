# AEPS Conformance Test Vectors

These fixtures are the conformance contract between AEPS reference implementations. Every implementation MUST produce the listed output for the listed input. Disagreement = bug in the implementation, NOT the spec.

License: MIT.

## Files

- [`merkle.json`](./merkle.json) — RFC 6962 Merkle root vectors. Six fixtures spanning the empty tree, single-leaf, balanced, unbalanced, and large trees.
- [`op_return.json`](./op_return.json) — AEPS §8.3 OP_RETURN payload format. Four fixtures.
- [`canonical_json.json`](./canonical_json.json) — Sorted-key JSON canonicalization vectors (subset of RFC 8785).

## How to verify conformance

### TypeScript reference (`aeps-node-ts`)

```bash
cd /path/to/satrank
npx vitest run src/tests/aepsConformance.test.ts
```

### Rust reference (`aeps-node-rs`)

```bash
cd /path/to/satrank/apps/aeps-node-rs
cargo test --test conformance
```

Both must pass with the same vectors. If they diverge, the spec has a bug or one of the implementations does. File an issue.

## Adding a new vector

1. Compute the expected output independently (via spec, not via either impl).
2. Add the fixture to the JSON file.
3. Run both test suites — both must agree.
4. Commit.

If the impls already agree but you cannot derive the expected output from the spec alone, the spec needs clarification — add a section to the whitepaper before adding the vector.
