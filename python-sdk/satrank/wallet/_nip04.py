"""NIP-04 encryption helpers — mirror of TS src/wallet/nip04.ts.

NIP-04 = ECDH(secp256k1) → AES-256-CBC with random 16-byte IV. The encrypted
payload is transmitted as "<ciphertext_b64>?iv=<iv_b64>". Pure stdlib.

We rely on cryptography for AES-CBC and ECDH. This is technically one runtime
dep, but it's the only sane path in Python for primitives the stdlib doesn't
expose (secp256k1 ECDH in particular is not in the stdlib).
"""

from __future__ import annotations

import base64
import os

try:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives.padding import PKCS7
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "NWC requires 'cryptography' — install satrank[nwc]"
    ) from exc


_CURVE = ec.SECP256K1()


def _load_priv(priv_hex: str) -> ec.EllipticCurvePrivateKey:
    priv_int = int(priv_hex, 16)
    return ec.derive_private_key(priv_int, _CURVE)


def _load_xonly_pub(x_only_hex: str) -> ec.EllipticCurvePublicKey:
    # NIP-04 treats the counterparty pubkey as x-only; we force the even y-parity
    # prefix (02) to reconstruct a compressed SEC1 encoding.
    compressed = b"\x02" + bytes.fromhex(x_only_hex)
    return ec.EllipticCurvePublicKey.from_encoded_point(_CURVE, compressed)


def derive_shared_secret(priv_hex: str, peer_x_only_hex: str) -> bytes:
    priv = _load_priv(priv_hex)
    pub = _load_xonly_pub(peer_x_only_hex)
    # ECDH on secp256k1 returns the x-coordinate of the shared point. NIP-04
    # uses that 32-byte value directly as the AES-256 key.
    shared = priv.exchange(ec.ECDH(), pub)
    return shared


def derive_public_key_x_only(priv_hex: str) -> str:
    priv = _load_priv(priv_hex)
    point = priv.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.CompressedPoint,
    )
    # Drop prefix byte → 32-byte x-only.
    return point[1:].hex()


def nip04_encrypt(plaintext: str, priv_hex: str, peer_x_only_hex: str) -> str:
    key = derive_shared_secret(priv_hex, peer_x_only_hex)
    iv = os.urandom(16)
    padder = PKCS7(algorithms.AES.block_size).padder()
    padded = padder.update(plaintext.encode("utf-8")) + padder.finalize()
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
    enc = cipher.encryptor()
    ct = enc.update(padded) + enc.finalize()
    return f"{base64.b64encode(ct).decode()}?iv={base64.b64encode(iv).decode()}"


def nip04_decrypt(payload: str, priv_hex: str, peer_x_only_hex: str) -> str:
    if "?iv=" not in payload:
        raise ValueError("NIP-04 payload missing ?iv= separator")
    ct_b64, iv_b64 = payload.split("?iv=", 1)
    key = derive_shared_secret(priv_hex, peer_x_only_hex)
    iv = base64.b64decode(iv_b64)
    ct = base64.b64decode(ct_b64)
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
    dec = cipher.decryptor()
    padded = dec.update(ct) + dec.finalize()
    unpadder = PKCS7(algorithms.AES.block_size).unpadder()
    plain = unpadder.update(padded) + unpadder.finalize()
    return plain.decode("utf-8")
