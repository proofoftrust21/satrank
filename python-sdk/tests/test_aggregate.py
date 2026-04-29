"""Tests for satrank.aggregate — federation discovery + filter primitives."""

from __future__ import annotations

import pytest

from satrank.aggregate import (
    aggregate_oracles,
    fetch_oracle_peers,
    filter_by_calibration_error,
)


def _make_peer(
    *,
    pubkey: str = "p1",
    catalogue_size: int = 100,
    stale_sec: int = 0,
    age_sec: int = 86400,
    calibration_event_id: str | None = "cal-event-1",
) -> dict:
    return {
        "oracle_pubkey": pubkey,
        "lnd_pubkey": None,
        "catalogue_size": catalogue_size,
        "calibration_event_id": calibration_event_id,
        "last_assertion_event_id": None,
        "contact": None,
        "onboarding_url": None,
        "last_seen": 0,
        "first_seen": 0,
        "age_sec": age_sec,
        "stale_sec": stale_sec,
        "latest_announcement_event_id": None,
    }


class TestFilterByCalibrationError:
    def test_empty_input(self):
        assert filter_by_calibration_error([]) == []

    def test_passes_default_criteria(self):
        peers = [_make_peer()]
        assert len(filter_by_calibration_error(peers)) == 1

    def test_rejects_stale(self):
        peers = [_make_peer(stale_sec=14 * 86400)]
        assert filter_by_calibration_error(peers, max_stale_sec=7 * 86400) == []

    def test_rejects_small_catalogue(self):
        peers = [_make_peer(catalogue_size=10)]
        assert filter_by_calibration_error(peers, min_catalogue_size=50) == []

    def test_rejects_no_calibration_when_required(self):
        peers = [_make_peer(calibration_event_id=None)]
        assert filter_by_calibration_error(peers, require_calibration=True) == []
        # Allowed when require_calibration=False:
        assert (
            len(filter_by_calibration_error(peers, require_calibration=False)) == 1
        )

    def test_rejects_too_young(self):
        peers = [_make_peer(age_sec=3600)]
        assert filter_by_calibration_error(peers, min_age_sec=86400) == []

    def test_keeps_only_passing_peers(self):
        peers = [
            _make_peer(pubkey="good", catalogue_size=100, stale_sec=0),
            _make_peer(pubkey="stale", stale_sec=14 * 86400),
            _make_peer(pubkey="small", catalogue_size=10),
            _make_peer(pubkey="no-cal", calibration_event_id=None),
        ]
        kept = filter_by_calibration_error(peers)
        assert len(kept) == 1
        assert kept[0]["oracle_pubkey"] == "good"


class TestFetchOraclePeers:
    @pytest.mark.asyncio
    async def test_handles_empty_data(self, monkeypatch):
        """When the oracle returns 200 with empty data, return zero peers."""

        class _StubResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return {"data": {"peers": [], "count": 0}}

        class _StubClient:
            async def get(self, *args, **kwargs):
                return _StubResponse()

            async def aclose(self):
                return None

        result = await fetch_oracle_peers(
            base_url="https://example.invalid",
            http=_StubClient(),  # type: ignore[arg-type]
        )
        assert result["peers"] == []
        assert result["count"] == 0
        assert result["source_oracle"] == "https://example.invalid"

    @pytest.mark.asyncio
    async def test_passes_through_peers(self, monkeypatch):
        peers = [_make_peer(pubkey="p1"), _make_peer(pubkey="p2")]

        class _StubResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return {"data": {"peers": peers, "count": 2}}

        class _StubClient:
            async def get(self, *args, **kwargs):
                return _StubResponse()

            async def aclose(self):
                return None

        result = await fetch_oracle_peers(
            base_url="https://example.invalid",
            http=_StubClient(),  # type: ignore[arg-type]
        )
        assert len(result["peers"]) == 2
        assert result["count"] == 2


class TestAggregateOracles:
    @pytest.mark.asyncio
    async def test_filters_after_fetching(self):
        """End-to-end: fetch returns mixed peers, aggregate keeps only the trustworthy."""
        peers = [
            _make_peer(pubkey="trusted", catalogue_size=200, stale_sec=3600),
            _make_peer(pubkey="stale", stale_sec=14 * 86400),
            _make_peer(pubkey="small", catalogue_size=5),
        ]

        class _StubResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return {"data": {"peers": peers, "count": 3}}

        class _StubClient:
            async def get(self, *args, **kwargs):
                return _StubResponse()

            async def aclose(self):
                return None

        result = await aggregate_oracles(
            base_url="https://example.invalid",
            min_catalogue_size=50,
            max_stale_sec=7 * 86400,
            require_calibration=True,
            http=_StubClient(),  # type: ignore[arg-type]
        )
        assert result["total_discovered"] == 3
        assert result["trusted_count"] == 1
        assert result["peers"][0]["oracle_pubkey"] == "trusted"
        assert result["source_oracle"] == "https://example.invalid"
