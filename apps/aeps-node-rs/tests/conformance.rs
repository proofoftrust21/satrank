//! AEPS conformance — Rust impl reads `../../spec/test-vectors/*.json` and
//! asserts identical output to the TS impl. Both must agree on every vector
//! or the spec is ambiguous.
//!
//! These vectors are the conformance contract that makes AEPS provably
//! multi-implementation rather than single-vendor.

use aeps_node::{
    evidence::build_op_return_payload,
    identity::NostrPubkey,
    merkle::merkle_root,
};
use serde::Deserialize;
use std::fs;
use std::path::PathBuf;

fn vectors_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("spec")
        .join("test-vectors")
}

#[derive(Debug, Deserialize)]
struct MerkleFixture {
    vectors: Vec<MerkleVector>,
}

#[derive(Debug, Deserialize)]
struct MerkleVector {
    name: String,
    leaves_hex: Vec<String>,
    expected_root_hex: String,
}

#[derive(Debug, Deserialize)]
struct OpReturnFixture {
    vectors: Vec<OpReturnVector>,
}

#[derive(Debug, Deserialize)]
struct OpReturnVector {
    name: String,
    operator_pubkey_hex: String,
    day_utc: String,
    root_hex: String,
    expected_payload_hex: String,
}

fn load_fixture<T: for<'de> Deserialize<'de>>(name: &str) -> T {
    let path = vectors_dir().join(name);
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {}", path.display(), e))
}

#[test]
fn merkle_conformance() {
    let fixture: MerkleFixture = load_fixture("merkle.json");
    for v in &fixture.vectors {
        let leaves: Vec<Vec<u8>> = v
            .leaves_hex
            .iter()
            .map(|h| hex::decode(h).expect("hex decode leaf"))
            .collect();
        let root = merkle_root(&leaves);
        let got = hex::encode(root);
        assert_eq!(got, v.expected_root_hex, "merkle vector '{}'", v.name);
    }
}

#[test]
fn op_return_conformance() {
    let fixture: OpReturnFixture = load_fixture("op_return.json");
    for v in &fixture.vectors {
        let pk = NostrPubkey::from_hex(&v.operator_pubkey_hex)
            .unwrap_or_else(|e| panic!("op pubkey {:?}", e));
        let mut root_bytes = [0u8; 32];
        let r = hex::decode(&v.root_hex).expect("root hex");
        assert_eq!(r.len(), 32, "root must be 32 bytes for vector '{}'", v.name);
        root_bytes.copy_from_slice(&r);
        let payload = build_op_return_payload(&pk, &v.day_utc, &root_bytes)
            .unwrap_or_else(|e| panic!("payload {:?}", e));
        let got = hex::encode(&payload);
        assert_eq!(got, v.expected_payload_hex, "op_return vector '{}'", v.name);
    }
}
