# AEPS — landing page

**AEPS — Agent Evidence and Payment Standard.** A protocol for autonomous
AI agents to discover, pay, and obtain cryptographic proof of fulfillment
from Internet APIs without intermediaries. Lightning-pure,
Bitcoin-anchored, MIT-licensed, no foundation.

This page indexes every AEPS-related resource in the repository so a
developer landing here can navigate without reading 40 commit messages.

## The spec

| Resource | What |
|---|---|
| [`spec/AEPS-whitepaper.md`](../spec/AEPS-whitepaper.md) | The protocol. ~9 pages, 13 sections : identity, capability, discovery, settlement, bonds, evidence + L1 anchor, fork detection, reputation, disputes, threat model, versioning + adoption. |
| [`spec/PROCESS.md`](../spec/PROCESS.md) | Evolution process. Forks, not votes. No foundation. Founder-exit at 5 years. |
| [`spec/LICENSE`](../spec/LICENSE) | MIT. The whitepaper, both reference impls, and the wire formats. |
| [`spec/README.md`](../spec/README.md) | Status, conformance overview, ratification criteria. |

## Conformance fixtures

Five implementations (server TS, TS SDK, Python SDK, Rust crate +
SDK consumers via the same fixtures) all produce **byte-identical**
output for the same input.

| Fixture | Section | Vectors |
|---|---|---|
| [`spec/test-vectors/merkle.json`](../spec/test-vectors/merkle.json) | RFC 6962 Merkle root | 6 |
| [`spec/test-vectors/op_return.json`](../spec/test-vectors/op_return.json) | §8.3 OP_RETURN payload | 4 |
| [`spec/test-vectors/dispute_outcome.json`](../spec/test-vectors/dispute_outcome.json) | §10 outcome message | 4 |
| [`spec/test-vectors/capability_descriptor.json`](../spec/test-vectors/capability_descriptor.json) | §4 capability descriptor | 2 |

How to run all four conformance suites :
[`spec/test-vectors/README.md`](../spec/test-vectors/README.md).

## Reference implementations

### TypeScript server (`src/`)

The HTTP surface, federation Nostr publishers/consumers, MCP bridge,
and §10 DLC-style dispute resolution all live here. Key services :

- `src/services/dailyMerkleAnchorService.ts` — §8 daily anchor
- `src/services/forkDetectionService.ts` — §8.5 observer
- `src/services/disputeService.ts` — §10 disputes (BIP-340 Schnorr)
- `src/services/equivocationClaimAdapter.ts` — equivocation slashing
- `src/services/equivocationSlashCron.ts` — §7.2 distribution
- `src/services/multiHopChainService.ts` — §6.3 atomic multi-hop
- `src/services/aepsCapability.ts` — §4 canonical descriptor + endpoint_id
- `src/services/aepsAnchorPublisher.ts` — kind 31403 publication
- `src/services/aepsForkPublisher.ts` — kind 31410 publication
- `src/nostr/kind31403Consumer.ts` — peer anchor ingestion
- `src/nostr/kind31410Consumer.ts` — peer fork ingestion

HTTP routes (under `/api/aeps/*`) :

- `dispute/*` — open / attest / get
- `multihop/*` — plan / lock / reveal / settle / abort / get
- `observation`, `forks`, `observations/:op/:day` — observer surface
- `anchor/:day`, `anchor/recent`, `proof/:receipt_id` — evidence reads

### Rust crate ([`apps/aeps-node-rs`](../apps/aeps-node-rs))

Conformance witness. Currently 32 unit tests + 4 conformance tests.
Modules : `merkle`, `identity`, `capability`, `evidence`, `dispute`.

## SDKs

Both at parity v1.6.0+. Reads + writes for §10 disputes, plus
zero-dep canonical-byte helpers for §4 capability descriptors and
§10 outcome messages.

### TypeScript SDK (`@satrank/sdk`, [`sdk/`](../sdk))

```typescript
import {
  SatRank,
  AepsDisputeNotFoundError,
  buildOutcomeMessageHash,
  buildCapabilityEndpointId,
  buildNip98EventTemplate,
  encodeNip98AuthHeader,
} from '@satrank/sdk';
```

- Methods : `openDispute`, `submitAttestation`, `getDispute`.
- URL helpers : `disputeEndpoint`, `attestationEndpoint(id)`.
- Helpers : `buildOutcomeMessage{,Hash}`, `buildCapabilityCanonicalBytes`,
  `buildCapabilityEndpointId`, `buildNip98EventTemplate`,
  `encodeNip98AuthHeader`.
- Errors : `AepsDispute{NotFound,NotOpen}Error`,
  `AepsOracleNotInSetError`, `AepsSignatureInvalidError`.

### Python SDK (`satrank`, [`python-sdk/`](../python-sdk))

Same surface, `snake_case` :

```python
from satrank import (
    SatRank,
    AepsDisputeNotFoundError,
    build_outcome_message_hash,
    build_capability_endpoint_id,
    build_nip98_event_template,
    encode_nip98_auth_header,
)
```

## Tutorials + worked examples

- **[`docs/sdk/aeps-disputes.md`](sdk/aeps-disputes.md)** — 5-minute
  AEPS §10 quickstart with TS + Python walkthroughs.
- [`sdk/examples/aeps-dispute.ts`](../sdk/examples/aeps-dispute.ts) —
  runnable TS file. `npx tsx sdk/examples/aeps-dispute.ts`.
- [`python-sdk/examples/aeps_dispute.py`](../python-sdk/examples/aeps_dispute.py) —
  runnable Python file.

## MCP integration

Claude Desktop / Cursor / any MCP host gets eight read-only tools :

| Tool | Section |
|---|---|
| `aeps.daily_anchor` | §8 daily Merkle root by day |
| `aeps.recent_anchors` | §8 latest N anchors |
| `aeps.inclusion_proof` | §8 RFC 6962 audit path for a receipt |
| `aeps.evidence_receipt` | §8 Ed25519-signed receipt by job_id |
| `aeps.get_dispute` | §10 dispute state + attestations |
| `aeps.list_forks` | §8.5 detected fork events |
| `aeps.get_observations` | §8.5 observation bucket for (op, day) |
| `aeps.get_multihop` | §6.3 multi-hop chain state + per-leg |

Configure via [`mcp-server.json`](../mcp-server.json).

## What's NOT yet shipped (v0.2 chapters)

- **Lightning disbursement** of disputant + observer slashing shares.
  v0.1 records the §7.2 80/15/5 split on `aeps_oracle_slash_intents`
  but does not emit Lightning payments yet.
- **Bitcoin L1 OP_RETURN broadcast** of daily Merkle roots. The code
  is structured (`L1_ANCHOR_ENABLED` env gate) ; activation needs
  Bitcoin RPC + UTXO management.
- **Real Lightning HTLC chain integration**. v0.1 ships the §6.3
  state machine ; activation needs operator capability advertisement
  (`multi_hop_capable: true` in their AEPS-conformant capability
  descriptor).

These are individually scoped v0.2 chapters that require external
collaboration (Lightning routing infrastructure, operator opt-in,
prod state-mod approval).

## Top-level CHANGELOG entry

The single canonical record of the v0.1 milestone is
[`CHANGELOG.md`](../CHANGELOG.md) under "AEPS v0.1 - 2026-05-08".
