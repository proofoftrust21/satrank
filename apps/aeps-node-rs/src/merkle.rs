//! AEPS §8.2 — RFC 6962 Merkle tree primitives.
//!
//! Mirror of `src/services/merkleTreeUtil.ts` in the TS reference. Both impls
//! produce the same root for the same leaves; this is verified by shared test
//! vectors.
//!
//! Reference: RFC 6962-bis §2.1.

use sha2::{Digest, Sha256};

const PREFIX_LEAF: u8 = 0x00;
const PREFIX_NODE: u8 = 0x01;

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}

/// `LeafHash(d) = SHA-256(0x00 || d)`.
pub fn leaf_hash(leaf: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([PREFIX_LEAF]);
    h.update(leaf);
    h.finalize().into()
}

/// `NodeHash(left, right) = SHA-256(0x01 || left || right)`.
pub fn node_hash(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([PREFIX_NODE]);
    h.update(left);
    h.update(right);
    h.finalize().into()
}

/// Empty Merkle root = `SHA-256("")`.
pub fn empty_root() -> [u8; 32] {
    sha256(&[])
}

/// Largest power of two strictly less than `n`. Panics if `n < 2`.
pub fn largest_power_of_two_less_than(n: usize) -> usize {
    assert!(n >= 2, "largest_power_of_two_less_than requires n>=2");
    let mut k = 1usize;
    while k * 2 < n {
        k *= 2;
    }
    k
}

/// RFC 6962 Merkle Tree Hash over an ordered list of leaves.
pub fn merkle_root(leaves: &[Vec<u8>]) -> [u8; 32] {
    if leaves.is_empty() {
        return empty_root();
    }
    if leaves.len() == 1 {
        return leaf_hash(&leaves[0]);
    }
    let k = largest_power_of_two_less_than(leaves.len());
    let left = merkle_root(&leaves[..k]);
    let right = merkle_root(&leaves[k..]);
    node_hash(&left, &right)
}

/// Bottom-up audit path for the leaf at `leaf_index` in `leaves`.
/// First entry is sibling at leaf level; last entry is sibling near root.
pub fn inclusion_proof(leaves: &[Vec<u8>], leaf_index: usize) -> Vec<[u8; 32]> {
    assert!(
        leaf_index < leaves.len(),
        "leaf_index {leaf_index} out of range"
    );
    if leaves.len() == 1 {
        return Vec::new();
    }
    path_recursive(leaves, leaf_index)
}

fn path_recursive(d: &[Vec<u8>], m: usize) -> Vec<[u8; 32]> {
    let n = d.len();
    if n == 1 {
        return Vec::new();
    }
    let k = largest_power_of_two_less_than(n);
    if m < k {
        let mut path = path_recursive(&d[..k], m);
        path.push(merkle_root(&d[k..]));
        path
    } else {
        let mut path = path_recursive(&d[k..], m - k);
        path.push(merkle_root(&d[..k]));
        path
    }
}

/// Verify an audit path against an expected root. RFC 6962-bis §2.1.3.2.
pub fn verify_inclusion_proof(
    leaf: &[u8],
    leaf_index: usize,
    tree_size: usize,
    audit_path: &[[u8; 32]],
    root_hash: &[u8; 32],
) -> bool {
    if tree_size == 0 || leaf_index >= tree_size {
        return false;
    }

    let mut fn_ = leaf_index;
    let mut sn = tree_size - 1;
    let mut r = leaf_hash(leaf);

    for p in audit_path {
        if sn == 0 {
            return false;
        }

        if fn_ & 1 == 1 || fn_ == sn {
            r = node_hash(p, &r);
            if fn_ & 1 == 0 {
                while fn_ & 1 == 0 && fn_ != 0 {
                    fn_ >>= 1;
                    sn >>= 1;
                }
            }
        } else {
            r = node_hash(&r, p);
        }

        fn_ >>= 1;
        sn >>= 1;
    }

    sn == 0 && r == *root_hash
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaves(hexes: &[&str]) -> Vec<Vec<u8>> {
        hexes.iter().map(|h| hex::decode(h).unwrap()).collect()
    }

    #[test]
    fn empty_root_matches_sha256_of_empty() {
        assert_eq!(empty_root(), sha256(&[]));
    }

    #[test]
    fn leaf_hash_applies_zero_prefix() {
        let data = hex::decode("aabbcc").unwrap();
        let mut expected = Vec::with_capacity(1 + data.len());
        expected.push(0x00);
        expected.extend_from_slice(&data);
        assert_eq!(leaf_hash(&data), sha256(&expected));
    }

    #[test]
    fn merkle_root_empty() {
        assert_eq!(merkle_root(&[]), empty_root());
    }

    #[test]
    fn merkle_root_single() {
        let d = vec![vec![0xde, 0xad, 0xbe, 0xef]];
        assert_eq!(merkle_root(&d), leaf_hash(&d[0]));
    }

    #[test]
    fn merkle_root_two() {
        let d = leaves(&["aa", "bb"]);
        let expected = node_hash(&leaf_hash(&d[0]), &leaf_hash(&d[1]));
        assert_eq!(merkle_root(&d), expected);
    }

    #[test]
    fn merkle_root_three_split_two_one() {
        let d = leaves(&["aa", "bb", "cc"]);
        let left = node_hash(&leaf_hash(&d[0]), &leaf_hash(&d[1]));
        let right = leaf_hash(&d[2]);
        let expected = node_hash(&left, &right);
        assert_eq!(merkle_root(&d), expected);
    }

    #[test]
    fn roundtrip_for_n_in_1_to_17() {
        for n in 1..=17usize {
            let mut ls = Vec::new();
            for i in 0..n {
                ls.push(vec![i as u8, ((i * 31) & 0xff) as u8, ((i * 7 + 13) & 0xff) as u8]);
            }
            let root = merkle_root(&ls);
            for i in 0..n {
                let proof = inclusion_proof(&ls, i);
                let ok = verify_inclusion_proof(&ls[i], i, n, &proof, &root);
                assert!(ok, "verification failed for n={n} i={i}");
            }
        }
    }

    #[test]
    fn rejects_wrong_leaf() {
        let ls = leaves(&["aa", "bb", "cc"]);
        let root = merkle_root(&ls);
        let proof = inclusion_proof(&ls, 1);
        let wrong = vec![0xff];
        assert!(!verify_inclusion_proof(&wrong, 1, 3, &proof, &root));
    }

    #[test]
    fn rejects_wrong_root() {
        let ls = leaves(&["aa", "bb", "cc"]);
        let proof = inclusion_proof(&ls, 0);
        let wrong = [0u8; 32];
        assert!(!verify_inclusion_proof(&ls[0], 0, 3, &proof, &wrong));
    }

    #[test]
    fn rejects_truncated_proof() {
        let ls = leaves(&["aa", "bb", "cc", "dd"]);
        let root = merkle_root(&ls);
        let proof = inclusion_proof(&ls, 2);
        let truncated = &proof[..1];
        assert!(!verify_inclusion_proof(&ls[2], 2, 4, truncated, &root));
    }

    #[test]
    fn rejects_index_out_of_range() {
        let ls = leaves(&["aa", "bb"]);
        let root = merkle_root(&ls);
        assert!(!verify_inclusion_proof(&ls[0], 5, 2, &[], &root));
    }
}
