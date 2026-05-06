# AEPS Spec Evolution Process

This document describes how AEPS evolves. It is intentionally minimal.

License: MIT.

---

## Principles

1. **Forks, not votes.** The protocol evolves by the market choosing among competing implementations and specs. No committee, no quorum, no on-chain governance token.
2. **Code is the spec.** The whitepaper is the roadmap. The reference implementations are normative. When they conflict, the running code wins. When two implementations diverge, the one with more economic activity wins.
3. **No rent extraction.** No AEPS Foundation, no governance token, no maintainer fee. Anyone may run a node. Anyone may fork.
4. **Founder exit.** After 5 years of demonstrated stability, the original author steps back from canonical-repo commit access. The protocol survives by code, not authority.

---

## Versioning

The protocol is versioned by the `version` field in the capability descriptor.

- **Major** bump = incompatible wire-format change. Old and new operators cannot interoperate without a translation layer.
- **Minor** bump = backward-compatible addition. Old operators ignore unknown fields; new operators publish new fields.
- **Patch** bump = clarification or bugfix in implementations only; no spec change.

The whitepaper file is named `AEPS-whitepaper.md` for the latest version. Historical drafts are tagged in the repo and named `AEPS-whitepaper-v0.1.md`, `AEPS-whitepaper-v0.2.md`, etc. The git tag is the canonical reference.

---

## Proposing changes

Anyone may propose a change. The mechanism is a pull request to the canonical repository (whichever one the market currently treats as canonical). Proposal format:

```
title: <short description>
type: clarification | extension | breaking
motivation: <why this change>
specification: <exact wire-format / state-machine deltas>
rationale: <design choices, alternatives considered>
backwards-compatibility: <impact on existing implementations>
reference-implementation: <PR link or "none yet">
```

Proposals do not require approval. They require an implementation that demonstrates the change works and operators willing to deploy it. If the change is good and useful, it spreads. If it is not, it does not.

There is no review committee. There is no vote. There is the running code.

---

## Reference implementations

For v0.1 ratification, two reference implementations are required:

- **`aeps-node-ts`** — TypeScript, MIT license. Initial reference written by the original author.
- **`aeps-node-rs`** — Rust, MIT license. LDK-based. Required as second-party validation that the spec is implementable from the document alone.

Subsequent versions may be ratified with one reference implementation if the wire-format change is small, but breaking changes always require two implementations to ratify.

Both implementations live in independent git repositories. Neither has authority over the other. When they diverge, the network operators choose which to follow.

---

## Wire-format ratification (BLIPs and NIPs)

AEPS wire formats that touch existing ecosystems are submitted upstream once stable:

- Lightning extensions (HTLC chain coordination, BOLT12 conventions for AEPS) → BLIPs.
- Nostr kinds (31402 endpoint advertisement, 31403 daily anchor, 31404 reputation receipt, 5402/6402 DVM job format) → NIPs.

Submitting these upstream is optional but encouraged. Upstream ratification does not give those ecosystems authority over AEPS — it gives AEPS interoperability with them.

If upstream rejects a wire format, AEPS continues using it. The ecosystems are downstream of the protocol, not upstream.

---

## Conflict resolution

When two operators or two implementations disagree on what the protocol says:

1. Read the latest tagged whitepaper. If it answers the question, that answer is canonical.
2. If the whitepaper is silent or ambiguous, the implementations decide by running code. The implementation in production by the most operators (measured by sum of operator bonds) wins.
3. If both implementations are equally deployed, the conflict is unresolved at the spec layer. Operators on each side continue to operate. The market resolves it over time.

There is no arbiter. There is no vote. There is no foundation.

---

## Founder exit clause

5 years from the v0.1 ratification date, the original author of this document:

1. Hands canonical-repo commit access to a multisig of the top 5 long-term contributors (measured by commits + bond stake).
2. Stops authoring or co-signing changes.
3. Continues to operate their own node if they wish, with no special authority.

This clause is a credible commitment that AEPS is not the founder's project after a stability period. It mirrors Satoshi's exit from Bitcoin.

---

## License

This document is MIT licensed. All reference implementations are MIT licensed. The wire formats are public. There is nothing here to capture.

If you fork this spec, fork it. If you change it, change it. If you ship a node, ship a node. Welcome.
