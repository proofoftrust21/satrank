//! AEPS §8 — Evidence receipts, daily Merkle batch, OP_RETURN payload.
//!
//! Mirrors `src/services/evidenceService.ts` and `src/services/dailyMerkleAnchorService.ts`
//! in the TypeScript reference. Both impls produce identical canonical bytes
//! and identical Merkle roots for the same input — the conformance contract.

use crate::identity::NostrPubkey;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const OP_RETURN_TAG: &[u8] = b"AEPS1";
const EPOCH_DAY_OFFSET_2026_01_01_UTC_SEC: i64 = 1_767_225_600;

/// Per-call evidence receipt (whitepaper §8.1).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EvidenceReceipt {
    pub receipt_id: String,
    pub endpoint_id: String,
    pub operator_pubkey: NostrPubkey,
    pub agent_pubkey: NostrPubkey,
    pub request_hash: String,
    pub response_hash: String,
    pub request_time_ms: i64,
    pub response_time_ms: i64,
    pub payment_preimage_hash: String,
    pub amount_msat: u64,
    pub schema_version: String,
}

#[derive(Error, Debug)]
pub enum EvidenceError {
    #[error("invalid signing key bytes")]
    InvalidSigningKey,
    #[error("invalid verifying key bytes")]
    InvalidVerifyingKey,
    #[error("signature verification failed")]
    BadSignature,
    #[error("hex decode: {0}")]
    HexDecode(#[from] hex::FromHexError),
    #[error("ed25519: {0}")]
    Ed25519(#[from] ed25519_dalek::ed25519::Error),
    #[error("invalid input length")]
    InvalidLength,
    #[error("invalid date format, expect YYYY-MM-DD")]
    InvalidDate,
}

/// Compute SHA-256 hex over arbitrary bytes (utility for request/response hashing).
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

/// Sign a canonical-JSON payload bytes with the operator's Ed25519 key.
/// Returns base64-encoded signature.
pub fn sign_ed25519(payload: &[u8], signing_key_hex: &str) -> Result<String, EvidenceError> {
    let sk_bytes = hex::decode(signing_key_hex)?;
    if sk_bytes.len() != 32 {
        return Err(EvidenceError::InvalidLength);
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&sk_bytes);
    let sk = SigningKey::from_bytes(&arr);
    let sig: Signature = sk.try_sign(payload)?;
    use base64::Engine as _;
    Ok(base64::engine::general_purpose::STANDARD.encode(sig.to_bytes()))
}

/// Verify an Ed25519 signature against a canonical payload + verifying key hex.
pub fn verify_ed25519(
    payload: &[u8],
    signature_b64: &str,
    verifying_key_hex: &str,
) -> Result<bool, EvidenceError> {
    let pk_bytes = hex::decode(verifying_key_hex)?;
    if pk_bytes.len() != 32 {
        return Err(EvidenceError::InvalidVerifyingKey);
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&pk_bytes);
    let vk = VerifyingKey::from_bytes(&arr).map_err(|_| EvidenceError::InvalidVerifyingKey)?;

    use base64::Engine as _;
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(signature_b64)
        .map_err(|_| EvidenceError::BadSignature)?;
    if sig_bytes.len() != 64 {
        return Err(EvidenceError::BadSignature);
    }
    let mut sig_arr = [0u8; 64];
    sig_arr.copy_from_slice(&sig_bytes);
    let sig = Signature::from_bytes(&sig_arr);
    Ok(vk.verify(payload, &sig).is_ok())
}

/// Build the AEPS §8.3 OP_RETURN payload : tag(5) || op8(8) || day_le(4) || root(32) = 49 bytes.
pub fn build_op_return_payload(
    operator_pubkey: &NostrPubkey,
    day_utc: &str,
    root_bytes: &[u8; 32],
) -> Result<Vec<u8>, EvidenceError> {
    let day_index = utc_day_index(day_utc)?;
    let mut out = Vec::with_capacity(49);
    out.extend_from_slice(OP_RETURN_TAG);
    out.extend_from_slice(&operator_pubkey.0[..8]);
    out.extend_from_slice(&day_index.to_le_bytes());
    out.extend_from_slice(root_bytes);
    Ok(out)
}

/// Days-since-2026-01-01 UTC for the given YYYY-MM-DD. Matches TS impl.
pub fn utc_day_index(day_utc: &str) -> Result<u32, EvidenceError> {
    if day_utc.len() != 10 || day_utc.as_bytes()[4] != b'-' || day_utc.as_bytes()[7] != b'-' {
        return Err(EvidenceError::InvalidDate);
    }
    let year: i64 = day_utc[0..4]
        .parse()
        .map_err(|_| EvidenceError::InvalidDate)?;
    let month: u32 = day_utc[5..7]
        .parse()
        .map_err(|_| EvidenceError::InvalidDate)?;
    let day: u32 = day_utc[8..10]
        .parse()
        .map_err(|_| EvidenceError::InvalidDate)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(EvidenceError::InvalidDate);
    }
    let secs = days_from_civil(year, month, day) * 86_400;
    let diff = secs - EPOCH_DAY_OFFSET_2026_01_01_UTC_SEC;
    if diff < 0 {
        return Err(EvidenceError::InvalidDate);
    }
    Ok((diff / 86_400) as u32)
}

/// Howard Hinnant's days_from_civil — converts (y,m,d) to days since 1970-01-01.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as i64;
    let m = m as i64;
    let d = d as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn op_return_payload_is_49_bytes() {
        let pk = NostrPubkey::from_hex(&"ab".repeat(32)).unwrap();
        let root = [0xcdu8; 32];
        let payload = build_op_return_payload(&pk, "2026-05-07", &root).unwrap();
        assert_eq!(payload.len(), 49);
        assert_eq!(&payload[..5], b"AEPS1");
        assert_eq!(&payload[5..13], &[0xab; 8]);
        let day_le = u32::from_le_bytes(payload[13..17].try_into().unwrap());
        assert_eq!(day_le, 126); // 2026-05-07 = 126 days after 2026-01-01
        assert_eq!(&payload[17..], &root);
    }

    #[test]
    fn day_index_zero_for_epoch() {
        assert_eq!(utc_day_index("2026-01-01").unwrap(), 0);
    }

    #[test]
    fn day_index_rejects_pre_epoch() {
        assert!(utc_day_index("2025-12-31").is_err());
    }

    #[test]
    fn day_index_progresses() {
        let a = utc_day_index("2026-05-07").unwrap();
        let b = utc_day_index("2026-05-08").unwrap();
        assert_eq!(b - a, 1);
    }

    #[test]
    fn day_index_rejects_malformed() {
        assert!(utc_day_index("2026-5-7").is_err());
        assert!(utc_day_index("not-a-date").is_err());
        assert!(utc_day_index("").is_err());
    }

    #[test]
    fn ed25519_sign_verify_roundtrip() {
        // Use a deterministic key for repeatable test
        let sk_hex = "11".repeat(32);
        let sig = sign_ed25519(b"hello AEPS", &sk_hex).unwrap();

        // Derive public key from signing key
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&hex::decode(&sk_hex).unwrap());
        let sk = SigningKey::from_bytes(&arr);
        let pk_hex = hex::encode(sk.verifying_key().as_bytes());

        assert!(verify_ed25519(b"hello AEPS", &sig, &pk_hex).unwrap());
        assert!(!verify_ed25519(b"different message", &sig, &pk_hex).unwrap());
    }
}
