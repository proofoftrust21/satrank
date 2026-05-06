//! AEPS §4 — Capability descriptor.
//!
//! A signed envelope describing one endpoint: input/output JSON Schemas,
//! pricing, evidence endpoint, bond pubkey, DLC oracle threshold. Per the
//! whitepaper, the descriptor is canonicalized via RFC 8785 and signed by
//! the operator's root key.
//!
//! v0.1 of this Rust impl provides the type definition and a sha256 over
//! the canonical bytes for `endpoint_id` derivation. JSON canonicalization
//! itself uses `serde_json` with sorted keys — full RFC 8785 conformance
//! (including number canonicalization) is in v0.2 once shared test vectors
//! exist with the TS reference.

use crate::identity::NostrPubkey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Serialized form of the AEPS §4 capability descriptor.
///
/// Field order follows the whitepaper §4 example. Optional fields default
/// to None when absent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CapabilityDescriptor {
    /// SHA-256 hex of the canonical descriptor bytes (without this field).
    /// Computed by [`Self::compute_endpoint_id`] before signing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_id: Option<String>,
    pub operator_pubkey: NostrPubkey,
    pub method: String,
    pub url: String,
    pub input_schema: serde_json::Value,
    pub output_schema: serde_json::Value,
    pub price_msat: u64,
    pub quote_validity_s: u32,
    pub evidence_endpoint: String,
    pub bond_pubkey: NostrPubkey,
    pub dlc_oracles: Vec<NostrPubkey>,
    pub dlc_threshold: u8,
    pub version: String,
}

impl CapabilityDescriptor {
    /// Compute SHA-256 hex over the canonical (endpoint_id-stripped) bytes.
    /// Used as the content address (`endpoint_id` field after first compute).
    pub fn compute_endpoint_id(&self) -> Result<String, serde_json::Error> {
        let mut copy = self.clone();
        copy.endpoint_id = None;
        let canon = canonical_json(&copy)?;
        let mut hasher = Sha256::new();
        hasher.update(canon.as_bytes());
        Ok(hex::encode(hasher.finalize()))
    }
}

/// JSON serialization with sorted top-level keys. Note: this is a v0.1
/// approximation. Full RFC 8785 compliance comes in v0.2.
pub fn canonical_json<T: Serialize>(value: &T) -> Result<String, serde_json::Error> {
    let v = serde_json::to_value(value)?;
    Ok(serialize_sorted(&v))
}

fn serialize_sorted(v: &serde_json::Value) -> String {
    use serde_json::Value;
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).unwrap(),
        Value::Array(arr) => {
            let parts: Vec<String> = arr.iter().map(serialize_sorted).collect();
            format!("[{}]", parts.join(","))
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap(),
                        serialize_sorted(&map[*k])
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_json_sorts_keys() {
        let v = serde_json::json!({ "b": 1, "a": 2 });
        assert_eq!(serialize_sorted(&v), r#"{"a":2,"b":1}"#);
    }

    #[test]
    fn canonical_json_recursive() {
        let v = serde_json::json!({ "z": { "y": 1, "x": 2 }, "a": [3, 2, 1] });
        assert_eq!(
            serialize_sorted(&v),
            r#"{"a":[3,2,1],"z":{"x":2,"y":1}}"#
        );
    }

    #[test]
    fn endpoint_id_is_deterministic() {
        let pk = NostrPubkey::from_hex(&"aa".repeat(32)).unwrap();
        let bond = NostrPubkey::from_hex(&"bb".repeat(32)).unwrap();
        let desc = CapabilityDescriptor {
            endpoint_id: None,
            operator_pubkey: pk,
            method: "POST".into(),
            url: "https://example/translate".into(),
            input_schema: serde_json::json!({ "type": "object" }),
            output_schema: serde_json::json!({ "type": "string" }),
            price_msat: 5000,
            quote_validity_s: 300,
            evidence_endpoint: "https://example/.well-known/aeps-evidence".into(),
            bond_pubkey: bond,
            dlc_oracles: vec![],
            dlc_threshold: 0,
            version: "0.1".into(),
        };
        let id1 = desc.compute_endpoint_id().unwrap();
        let id2 = desc.compute_endpoint_id().unwrap();
        assert_eq!(id1, id2);
        assert_eq!(id1.len(), 64);
    }
}
