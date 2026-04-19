"""bolt11 amount decoder — mirrors TS bolt11.test.ts."""

from __future__ import annotations

import pytest

from satrank.bolt11 import decode_bolt11_amount


@pytest.mark.parametrize(
    "bolt11,expected",
    [
        ("lnbc1u1p5xyz", 100),  # 1u = 0.000001 BTC = 100 sats
        ("lnbc10n1pabc", 1),  # 10n = 10 * 1e-9 BTC = 1 sat
        ("lnbc100n1p", 10),  # 100n = 10 sats
        ("lnbc1m1p", 100_000),  # 1m = 0.001 BTC = 100_000 sats
        ("LNBC1U1PABC", 100),  # case-insensitive prefix
        ("lntb10n1abc", 1),  # testnet prefix
        ("lnbcrt100n1abc", 10),  # regtest prefix
    ],
)
def test_decode_known_amounts(bolt11: str, expected: int) -> None:
    assert decode_bolt11_amount(bolt11) == expected


def test_amountless_invoice_returns_none() -> None:
    # "lnbc1pxyz" — "1" here is a bech32 separator, not an amount.
    assert decode_bolt11_amount("lnbcp1abc") is None


def test_non_bolt11_returns_none() -> None:
    assert decode_bolt11_amount("not-a-bolt11") is None
    assert decode_bolt11_amount("") is None


def test_empty_input_returns_none() -> None:
    assert decode_bolt11_amount("   ") is None
    assert decode_bolt11_amount(None) is None  # type: ignore[arg-type]
