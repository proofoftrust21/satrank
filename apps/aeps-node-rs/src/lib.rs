//! AEPS — Agent Evidence and Payment Standard. Rust reference implementation.
//!
//! See `../../../spec/AEPS-whitepaper.md` for the protocol specification.
//!
//! This crate ships the cryptographic primitives and data types that any
//! AEPS-conformant node must implement:
//!
//! - [`merkle`] : RFC 6962 Merkle tree (leaf prefix 0x00, node prefix 0x01).
//! - [`identity`] : Nostr secp256k1 pubkey types and NIP-26 delegation.
//! - [`capability`] : capability-descriptor parsing and canonical hashing.
//! - [`evidence`] : Ed25519-signed receipts, Merkle batch, OP_RETURN payload.
//!
//! Conformance with the TypeScript reference (`aeps-node-ts`) is verified by
//! shared test vectors. See README for the test-vector contract.

pub mod capability;
pub mod evidence;
pub mod identity;
pub mod merkle;

/// Crate version string for runtime introspection.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
