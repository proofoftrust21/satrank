# AEPS Conformance Test Vectors

These fixtures are the conformance contract between AEPS reference
implementations and SDK consumers. Every implementation MUST produce
the listed output for the listed input. Disagreement = bug in the
implementation, NOT the spec.

License: MIT.

## Files

| Fixture | Section | Vectors |
|---|---|---|
| [`merkle.json`](./merkle.json) | RFC 6962 Merkle root | 6 (empty / 1 / 2 / 3 / 5 / 8 leaves) |
| [`op_return.json`](./op_return.json) | §8.3 OP_RETURN payload | 4 (epoch / mid-2026 / year-end / +1y) |
| [`dispute_outcome.json`](./dispute_outcome.json) | §10 outcome message | 4 (short id × 2 outcomes, canonical 32-hex × 2 outcomes) |
| [`capability_descriptor.json`](./capability_descriptor.json) | §4 capability descriptor | 2 (minimal / nested schemas + 3 oracles) |

**16 vectors total** across **5 byte-format-normative sections** of the
whitepaper.

## How to verify conformance

### Server (TypeScript, `src/`)

```bash
npx vitest run src/tests/aepsConformance.test.ts
```

### TypeScript SDK (`@satrank/sdk`, `sdk/`)

```bash
cd sdk && npx vitest run tests/aepsHelpers.test.ts
```

### Python SDK (`satrank`, `python-sdk/`)

```bash
cd python-sdk && python3 -m pytest tests/test_aeps_helpers.py
```

### Rust reference (`aeps-node-rs`, `apps/aeps-node-rs/`)

```bash
cd apps/aeps-node-rs && cargo test --test conformance
```

All four impls must pass with the same vectors. If any diverges, the
spec has a bug OR one of the implementations does. File an issue
referencing the failing vector name + the impl that diverged.

## Adding a new vector

1. **Derive the expected output from the spec, not from any impl.**
   The whitepaper is normative ; if you can only compute the expected
   bytes by running an existing impl, the spec is ambiguous and you
   must clarify the whitepaper first.
2. Add the fixture to the appropriate JSON file (or create a new
   one + add a loader to each impl's conformance test file).
3. Run all four test suites. They must all pass.
4. Commit the fixture + any test-loader changes in the same commit.

If two impls already agree on bytes you cannot derive from the spec
alone : that's a "concrete protocol convention not in the whitepaper."
File a whitepaper PR clarifying the convention BEFORE shipping the
fixture.

## Why this matters

A protocol with two reference implementations and a fixture that both
read is a multi-vendor standard. A protocol with one implementation
and no fixture is a vendor product. AEPS chose the former — the
fixture format is what makes the choice durable.
