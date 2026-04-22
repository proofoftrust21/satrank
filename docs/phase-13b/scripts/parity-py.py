"""Head-to-head: same inputs as parity-ts.mjs."""
import json
from satrank.nlp import parse_intent

cases = [
    ("I need weather data for Paris", ["data", "weather"]),
    ("find me a cheap weather api for paris under 50 sats", ["data", "weather", "payment"]),
    ("💥💥💥", ["data"]),
    ("pay for gpt prompt 200 tokens", ["data", "payment", "llm"]),
]
for text, cats in cases:
    p = parse_intent(text, {"categories": cats})
    print(json.dumps({"input": text[:40], "cats": cats, "parsed": p}))
