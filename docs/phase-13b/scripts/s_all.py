"""Python SDK parity check (corrected for dict-based return types)."""
import asyncio
import time
import json
from satrank import SatRank, SatRankError
from satrank.nlp import parse_intent

def ms(t0): return round((time.perf_counter() - t0) * 1000)

async def main():
    sr = SatRank(api_base="https://satrank.dev", caller="phase-13b-python")

    print("=== S1 discovery ===")
    t0 = time.perf_counter()
    cats = await sr.list_categories()
    print(json.dumps({"step": "list_categories", "ms": ms(t0),
                      "count": len(cats.get("categories", []))}))

    t0 = time.perf_counter()
    cat_names = [c["name"] for c in cats.get("categories", [])] or ["data", "weather"]
    parsed = parse_intent("I need weather data for Paris", {"categories": cat_names})
    print(json.dumps({"step": "parse_intent", "ms": ms(t0), "parsed": parsed}))

    print("=== S4 fulfill (no wallet) ===")
    t0 = time.perf_counter()
    try:
        result = await sr.fulfill(intent={"category": "data/weather"}, budget_sats=50)
        print(json.dumps({"step": "fulfill", "ms": ms(t0), "result": result}))
    except Exception as e:
        print(json.dumps({"step": "fulfill", "ms": ms(t0),
                          "error_class": type(e).__name__,
                          "code": getattr(e, "code", None),
                          "message": str(e)[:180]}))

    print("=== S5 budget reject ===")
    t0 = time.perf_counter()
    try:
        result = await sr.fulfill(intent={"category": "data/weather"}, budget_sats=1)
        print(json.dumps({"step": "fulfill_low_budget", "ms": ms(t0), "result": result}))
    except Exception as e:
        print(json.dumps({"step": "fulfill_low_budget", "ms": ms(t0),
                          "error_class": type(e).__name__,
                          "code": getattr(e, "code", None),
                          "message": str(e)[:180]}))

    print("=== S9 malformed ===")
    for label, text in [("empty", ""), ("emoji", "💥💥💥"),
                        ("long", "need " * 200 + "weather paris")]:
        try:
            p = parse_intent(text, {"categories": ["data", "weather"]})
            print(f"[{label}] parsed: {p}")
        except Exception as e:
            print(f"[{label}] {type(e).__name__}: {e}")

    try:
        await sr.resolve_intent(category="💥💥", limit=1)
    except Exception as e:
        print(f"resolve emoji: {type(e).__name__}: {str(e)[:120]}")

    try:
        await sr.resolve_intent(category="data", budget_sats=float("nan"), limit=1)
    except Exception as e:
        print(f"resolve NaN: {type(e).__name__}: {str(e)[:120]}")

    if hasattr(sr, "aclose"):
        await sr.aclose()

asyncio.run(main())
