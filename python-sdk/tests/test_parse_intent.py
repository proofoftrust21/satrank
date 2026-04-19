"""parse_intent() unit coverage — mirrors TS parseIntent.test.ts (EN-only)."""

from __future__ import annotations

import pytest

from satrank.nlp import parse_intent

CATS = [
    "data",
    "data/finance",
    "data/health",
    "data/weather",
    "ai",
    "ai/text",
    "ai/code",
    "tools",
    "tools/search",
    "bitcoin",
    "media",
]


# ---- category resolution -------------------------------------------------

def test_literal_category_verbatim() -> None:
    r = parse_intent("I need data/finance numbers", {"categories": CATS})
    assert r["intent"]["category"] == "data/finance"
    assert r["category_confidence"] == 1.0


def test_single_token_category() -> None:
    r = parse_intent("Give me bitcoin price info", {"categories": CATS})
    assert r["intent"]["category"] == "bitcoin"


def test_empty_when_no_match() -> None:
    r = parse_intent("cook me a pizza", {"categories": CATS})
    assert r["intent"]["category"] == ""
    assert r["category_confidence"] == 0


def test_synonyms_win() -> None:
    r = parse_intent(
        "give me a weather forecast",
        {"categories": CATS, "synonyms": {"weather forecast": "data/weather"}},
    )
    assert r["intent"]["category"] == "data/weather"
    assert r["category_confidence"] == 1.0


def test_partial_hits_fractional() -> None:
    r = parse_intent("get me some health info", {"categories": CATS})
    assert r["intent"]["category"] == "data/health"
    assert r["category_confidence"] == pytest.approx(0.5, abs=0.01)


def test_tiebreak_prefers_longer_category() -> None:
    r = parse_intent("ai/code helper under 200 sats", {"categories": CATS})
    assert r["intent"]["category"] == "ai/code"


# ---- budget extraction ---------------------------------------------------

@pytest.mark.parametrize(
    "text,expected",
    [
        ("bitcoin tools under 50 sats", 50),
        ("data max 200 sats", 200),
        ("ai for 100 sats", 100),
        ("tools 25 sats", 25),
        ("ai 1,000 sats", 1000),
    ],
)
def test_budget_patterns(text: str, expected: int) -> None:
    r = parse_intent(text, {"categories": CATS})
    assert r["intent"].get("budget_sats") == expected


def test_budget_not_extracted_without_number() -> None:
    r = parse_intent("paying in sats for data", {"categories": CATS})
    assert "budget_sats" not in r["intent"]


# ---- latency extraction --------------------------------------------------

def test_within_seconds() -> None:
    r = parse_intent("ai/text within 3 seconds", {"categories": CATS})
    assert r["intent"]["max_latency_ms"] == 3000


def test_under_ms() -> None:
    r = parse_intent("tools under 500ms", {"categories": CATS})
    assert r["intent"]["max_latency_ms"] == 500


def test_urgent_keyword_1000ms() -> None:
    r = parse_intent("urgent bitcoin price", {"categories": CATS})
    assert r["intent"]["max_latency_ms"] == 1000


def test_fast_keyword_2000ms() -> None:
    r = parse_intent("fast data", {"categories": CATS})
    assert r["intent"]["max_latency_ms"] == 2000


def test_numeric_wins_over_keyword() -> None:
    r = parse_intent("fast tools under 250ms", {"categories": CATS})
    assert r["intent"]["max_latency_ms"] == 250


def test_no_latency_signal() -> None:
    r = parse_intent("give me bitcoin data", {"categories": CATS})
    assert "max_latency_ms" not in r["intent"]


# ---- keyword extraction --------------------------------------------------

def test_keywords_exclude_stopwords_and_category() -> None:
    r = parse_intent(
        "I need the latest bitcoin price quickly", {"categories": CATS}
    )
    kw = r["intent"].get("keywords", [])
    assert "latest" in kw
    assert "bitcoin" not in kw
    assert "the" not in kw
    assert "i" not in kw


def test_keywords_capped_at_5() -> None:
    r = parse_intent(
        "weather storm radar precipitation humidity pressure wind chill",
        {"categories": CATS},
    )
    assert len(r["intent"].get("keywords", [])) <= 5


def test_keywords_deduped() -> None:
    r = parse_intent("weather storm storm storm", {"categories": CATS})
    kws = r["intent"].get("keywords", [])
    assert kws.count("storm") == 1


def test_keywords_skipped_when_only_stopwords() -> None:
    r = parse_intent("please tell me about it", {"categories": CATS})
    assert "keywords" not in r["intent"]


# ---- full-sentence fixtures ---------------------------------------------

def test_fixture_weather_fast_under_50() -> None:
    r = parse_intent("I need weather data fast under 50 sats", {"categories": CATS})
    assert r["intent"]["category"] == "data/weather"
    assert r["intent"]["budget_sats"] == 50
    assert r["intent"]["max_latency_ms"] == 2000


def test_fixture_bitcoin_price_3s_10sats() -> None:
    r = parse_intent(
        "give me the bitcoin price within 3 seconds for 10 sats",
        {"categories": CATS},
    )
    assert r["intent"]["category"] == "bitcoin"
    assert r["intent"]["budget_sats"] == 10
    assert r["intent"]["max_latency_ms"] == 3000


def test_fixture_ai_code_helper() -> None:
    r = parse_intent("ai/code helper under 200 sats", {"categories": CATS})
    assert r["intent"]["category"] == "ai/code"
    assert r["intent"]["budget_sats"] == 200
    assert "helper" in (r["intent"].get("keywords") or [])


def test_fixture_search_engine_typescript() -> None:
    r = parse_intent(
        "search engine for typescript libraries", {"categories": CATS}
    )
    assert r["intent"]["category"] == "tools/search"
    kws = r["intent"].get("keywords") or []
    assert {"engine", "typescript", "libraries"} <= set(kws)


# ---- input guards -------------------------------------------------------

def test_empty_input_raises() -> None:
    with pytest.raises(ValueError, match="non-empty"):
        parse_intent("", {"categories": CATS})
    with pytest.raises(ValueError, match="non-empty"):
        parse_intent("   ", {"categories": CATS})


def test_categories_must_be_list() -> None:
    with pytest.raises(ValueError, match="list"):
        parse_intent("anything", {"categories": "data"})  # type: ignore[typeddict-item]


def test_empty_categories_returns_zero_confidence() -> None:
    r = parse_intent("I want bitcoin", {"categories": []})
    assert r["category_confidence"] == 0.0
