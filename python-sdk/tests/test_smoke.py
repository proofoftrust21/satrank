"""Structural smoke — public exports + constructor guardrails. Mirrors TS smoke.test.ts."""

from __future__ import annotations

import pytest

from satrank import SatRank, SatRankError, ValidationSatRankError, WalletError


def test_exports_present() -> None:
    assert SatRank is not None
    assert SatRankError is not None
    assert isinstance(ValidationSatRankError("bad"), SatRankError)


def test_ctor_trims_trailing_slash() -> None:
    sr = SatRank(api_base="https://satrank.dev/")
    assert sr._api_base == "https://satrank.dev"


def test_ctor_rejects_empty_api_base() -> None:
    with pytest.raises(ValueError, match="api_base is required"):
        SatRank(api_base="")


async def test_fulfill_rejects_missing_category() -> None:
    sr = SatRank(api_base="https://satrank.dev")
    with pytest.raises(ValueError, match="intent"):
        await sr.fulfill(intent={}, budget_sats=10)  # type: ignore[typeddict-item]
    with pytest.raises(ValueError, match="budget_sats"):
        await sr.fulfill(intent={"category": "data"}, budget_sats=0)


def test_wallet_error_is_plain_exception() -> None:
    err = WalletError("no route", "NO_ROUTE")
    assert isinstance(err, Exception)
    assert not isinstance(err, SatRankError)
    assert err.code == "NO_ROUTE"
