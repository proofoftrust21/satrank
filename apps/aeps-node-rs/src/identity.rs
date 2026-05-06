//! AEPS §3 — Identity types: Nostr secp256k1 pubkeys and NIP-26 delegation.
//!
//! Per the whitepaper, identity is a Nostr secp256k1 public key encoded as
//! 32-byte hex (NIP-01). Delegation follows NIP-26: a primary key signs a
//! delegation tag scoping a delegate key's authority.
//!
//! This module provides the type definitions and parse/serialize helpers.
//! Signing/verification is performed by [`crate::evidence`] for Ed25519
//! receipts and would use `secp256k1` for Nostr event signatures (deferred
//! to v0.2 of this crate).

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 32-byte secp256k1 pubkey encoded as 64 hex chars (NIP-01).
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NostrPubkey(pub [u8; 32]);

impl std::fmt::Debug for NostrPubkey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "NostrPubkey({})", hex::encode(self.0))
    }
}

impl std::fmt::Display for NostrPubkey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&hex::encode(self.0))
    }
}

#[derive(Error, Debug, PartialEq)]
pub enum NostrPubkeyError {
    #[error("hex must be 64 chars, got {0}")]
    InvalidLength(usize),
    #[error("hex decode error")]
    InvalidHex,
}

impl NostrPubkey {
    /// Parse a 64-char lowercase hex string.
    pub fn from_hex(s: &str) -> Result<Self, NostrPubkeyError> {
        if s.len() != 64 {
            return Err(NostrPubkeyError::InvalidLength(s.len()));
        }
        let bytes = hex::decode(s).map_err(|_| NostrPubkeyError::InvalidHex)?;
        let mut out = [0u8; 32];
        out.copy_from_slice(&bytes);
        Ok(NostrPubkey(out))
    }

    /// 64-char lowercase hex.
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }

    /// Raw 32 bytes.
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// NIP-26 delegation tag fields. Spec deferred to v0.2 — placeholder for now.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DelegationTag {
    pub root: NostrPubkey,
    pub conditions: String,
    pub signature_hex: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_64_char_hex() {
        let s = "aa".repeat(32);
        let pk = NostrPubkey::from_hex(&s).unwrap();
        assert_eq!(pk.to_hex(), s);
    }

    #[test]
    fn rejects_short_hex() {
        let s = "aa".repeat(31);
        assert_eq!(
            NostrPubkey::from_hex(&s).unwrap_err(),
            NostrPubkeyError::InvalidLength(62)
        );
    }

    #[test]
    fn rejects_bad_hex() {
        let s = "z".repeat(64);
        assert_eq!(
            NostrPubkey::from_hex(&s).unwrap_err(),
            NostrPubkeyError::InvalidHex
        );
    }

    #[test]
    fn display_matches_to_hex() {
        let s = "11".repeat(32);
        let pk = NostrPubkey::from_hex(&s).unwrap();
        assert_eq!(format!("{pk}"), s);
    }
}
