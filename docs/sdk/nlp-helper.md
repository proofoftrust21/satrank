# NLP helper — `parseIntent` / `parse_intent`

The SDK ships a tiny, deterministic, **English-only** NLP helper that maps a
free-text prompt to a structured `Intent`. It's the minimum viable glue
between "a user typed something" and "SatRank's `POST /api/intent` needs a
category + filters".

## What it does

Given a string and the live list of categories, it returns:

```typescript
{
  intent: {
    category: string;            // one of your categories, or "" if no match
    keywords?: string[];         // ≤5 non-stopword tokens
    budget_sats?: number;        // extracted from "under 50 sats", "max 200 sats", ...
    max_latency_ms?: number;     // from "within 3 seconds", "under 500ms", "urgent", "fast"
  };
  category_confidence: number;           // 0.0–1.0
  ambiguous_categories?: string[];       // when top-2 are within 0.15
}
```

Zero runtime deps, deterministic output, sub-millisecond latency, ~300 LOC.

## When to use it

✅ **Agent receives raw user text** and has to turn it into a fulfill() call.

```typescript
const parsed = parseIntent(userMessage, { categories: cats });
if (parsed.category_confidence < 0.5) {
  return `I can help with ${cats.slice(0, 5).join(', ')}. What category?`;
}
const result = await sr.fulfill({ intent: parsed.intent, budget_sats: 50 });
```

✅ **LLM agents prompted in English** (LangChain, LangGraph, AutoGen, CrewAI).
Their output is almost always English — `parseIntent` hits the 80/20.

✅ **CLI / REPL tools** where structured input is overkill.

## When NOT to use it

❌ **You already know the category programmatically.** Skip the helper:

```typescript
await sr.fulfill({
  intent: { category: 'data/weather', keywords: ['paris'], budget_sats: 50 },
  budget_sats: 50,
});
```

Passing an intent structured by your own logic is always preferable to
round-tripping through a text parser.

❌ **Non-English input.** `parseIntent` is English-only in SDK 1.0 (Phase 6bis
may add FR/ES/DE). For non-English input, build the intent yourself or use a
real NLU layer upstream.

❌ **You need semantic understanding** (synonyms beyond your own mapping,
entity linking, intent disambiguation). Use an LLM; pass its structured output
to `sr.fulfill()` directly.

❌ **Ambiguous prompts where confidence matters.** The helper returns a
`category_confidence` score — below 0.5, ask the user to clarify rather than
guessing.

## Patterns it recognises

### Budget

| Example | → `budget_sats` |
|---|---|
| `under 50 sats` | 50 |
| `max 200 sats` | 200 |
| `at most 100 satoshi` | 100 |
| `for 25 sats` | 25 |
| `less than 10 sats` | 10 |
| `1,000 sats` (in context) | 1000 |

No amount → no `budget_sats` in the output.

### Latency

| Example | → `max_latency_ms` |
|---|---|
| `within 3 seconds` | 3000 |
| `under 500ms` | 500 |
| `less than 1 second` | 1000 |
| `urgent` (no number) | 1000 |
| `fast` (no number) | 2000 |

A numeric value always wins over keyword hints.

### Category resolution

The helper scores each candidate category:

1. Exact substring match in the input → score **1.0** (`"i need bitcoin price"` → `bitcoin`).
2. Slash-separated categories (`data/weather`) — if the full string appears, score 1.0. Otherwise fraction of parts that hit tokens (1/2 for `data/weather` if only `weather` is present).
3. Custom synonyms (optional) can raise specific phrases to 1.0.

Tiebreak: longer category wins (`ai/code` > `ai` when both score 1.0).

### Synonyms

Pass a map to bend the default lexicon:

```typescript
parseIntent('give me a weather forecast', {
  categories: cats,
  synonyms: { 'weather forecast': 'data/weather' },
});
// → category: 'data/weather', confidence: 1.0
```

Python mirror:

```python
parse_intent(
    "give me a weather forecast",
    {"categories": cats, "synonyms": {"weather forecast": "data/weather"}},
)
```

## Parity between TS and Python

The same input produces the same structured output. Verified by identical
fixture tests on both sides — example:

```
parseIntent('bitcoin price under 10 sats', { categories: [...] })
parse_intent('bitcoin price under 10 sats', {'categories': [...]})

both return:
  { intent: { category: 'bitcoin', budget_sats: 10 }, category_confidence: 1.0 }
```

## API reference

### TypeScript

```typescript
import { parseIntent } from '@satrank/sdk/nlp';

parseIntent(input: string, opts: {
  categories: string[];              // the list of live category names
  synonyms?: Record<string, string>; // optional phrase → category overrides
}): {
  intent: Intent;
  category_confidence: number;
  ambiguous_categories?: string[];
};
```

### Python

```python
from satrank.nlp import parse_intent

parse_intent(input: str, opts: {"categories": list[str], "synonyms"?: dict[str, str]}) -> {
    "intent": dict,
    "category_confidence": float,
    "ambiguous_categories"?: list[str],
}
```

## Full pipeline

```python
async with SatRank(api_base="https://satrank.dev", wallet=wallet) as sr:
    cats = [c["name"] for c in (await sr.list_categories())["categories"]]
    parsed = parse_intent(user_message, {"categories": cats})

    if parsed["category_confidence"] < 0.5:
        raise ValueError("couldn't identify category")

    result = await sr.fulfill(
        intent=parsed["intent"],
        budget_sats=parsed["intent"].get("budget_sats", 50),
    )
```
