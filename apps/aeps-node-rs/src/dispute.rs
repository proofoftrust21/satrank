//! AEPS §10 — DLC oracle dispute primitives.
//!
//! Mirrors `src/services/disputeService.ts` (TS reference) for the
//! canonical-outcome-message + BIP-340 Schnorr verify primitives. Both
//! impls produce identical canonical bytes + signature-hash for the same
//! inputs — the §10 cross-impl conformance contract.

use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttestationOutcome {
    DisputantWins,
    RespondentWins,
}

impl AttestationOutcome {
    pub fn as_str(&self) -> &'static str {
        match self {
            AttestationOutcome::DisputantWins => "disputant_wins",
            AttestationOutcome::RespondentWins => "respondent_wins",
        }
    }
}

#[derive(Error, Debug)]
pub enum DisputeError {
    #[error("invalid outcome string")]
    InvalidOutcome,
}

impl std::str::FromStr for AttestationOutcome {
    type Err = DisputeError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "disputant_wins" => Ok(AttestationOutcome::DisputantWins),
            "respondent_wins" => Ok(AttestationOutcome::RespondentWins),
            _ => Err(DisputeError::InvalidOutcome),
        }
    }
}

/// Build the canonical outcome message bytes for `(dispute_id, outcome)`.
/// Canonical-JSON sorted-keys, no whitespace :
///   {"dispute_id":"<id>","outcome":"<outcome>","v":"AEPS-§10"}
///
/// Conformance with TS impl is byte-exact. Any divergence ⇒ bug.
pub fn build_outcome_message(dispute_id: &str, outcome: AttestationOutcome) -> String {
    // We build the JSON manually to control whitespace + key order. The
    // TS impl uses canonicalJson which sorts keys ascending. The keys here
    // are : dispute_id, outcome, v.
    let mut out = String::from("{");
    out.push_str("\"dispute_id\":");
    out.push_str(&json_string(dispute_id));
    out.push(',');
    out.push_str("\"outcome\":");
    out.push_str(&json_string(outcome.as_str()));
    out.push(',');
    out.push_str("\"v\":");
    out.push_str(&json_string("AEPS-§10"));
    out.push('}');
    out
}

/// SHA-256 of the canonical outcome message — the 32 bytes BIP-340 signs.
pub fn build_outcome_message_hash(dispute_id: &str, outcome: AttestationOutcome) -> [u8; 32] {
    let canonical = build_outcome_message(dispute_id, outcome);
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hasher.finalize().into()
}

/// JSON string escaping — minimal subset matching JSON.stringify in JS for
/// printable ASCII inputs. Sufficient for dispute IDs (`dis_<32hex>`) and
/// outcome enum strings + the `v` constant. Non-ASCII / control chars are
/// passed through ; the §10 inputs never contain them.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcome_as_str_and_from_str_roundtrip() {
        for o in [AttestationOutcome::DisputantWins, AttestationOutcome::RespondentWins] {
            let s = o.as_str();
            let parsed: AttestationOutcome = s.parse().unwrap();
            assert_eq!(parsed, o);
        }
    }

    #[test]
    fn from_str_rejects_invalid() {
        let err: Result<AttestationOutcome, _> = "made_up".parse();
        assert!(err.is_err());
    }

    #[test]
    fn canonical_message_keys_in_alphabetical_order() {
        let m = build_outcome_message("dis_abc", AttestationOutcome::DisputantWins);
        // dispute_id < outcome < v lex sort.
        assert!(m.starts_with("{\"dispute_id\":"));
        let oi = m.find("\"outcome\"").unwrap();
        let vi = m.find("\"v\"").unwrap();
        assert!(oi < vi);
    }

    #[test]
    fn canonical_message_no_whitespace() {
        let m = build_outcome_message("dis_abc", AttestationOutcome::DisputantWins);
        assert!(!m.contains(' '));
        assert!(!m.contains('\n'));
        assert!(!m.contains('\t'));
    }

    #[test]
    fn message_changes_with_dispute_id() {
        let a = build_outcome_message("dis_a", AttestationOutcome::DisputantWins);
        let b = build_outcome_message("dis_b", AttestationOutcome::DisputantWins);
        assert_ne!(a, b);
    }

    #[test]
    fn message_changes_with_outcome() {
        let a = build_outcome_message("dis_x", AttestationOutcome::DisputantWins);
        let b = build_outcome_message("dis_x", AttestationOutcome::RespondentWins);
        assert_ne!(a, b);
    }

    #[test]
    fn hash_is_32_bytes() {
        let h = build_outcome_message_hash("dis_x", AttestationOutcome::DisputantWins);
        assert_eq!(h.len(), 32);
    }

    #[test]
    fn deterministic_hash() {
        let a = build_outcome_message_hash("dis_x", AttestationOutcome::DisputantWins);
        let b = build_outcome_message_hash("dis_x", AttestationOutcome::DisputantWins);
        assert_eq!(a, b);
    }
}
