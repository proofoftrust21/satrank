# SatRank V3 simulation harness

Runs N agent personas (Anthropic Opus 4.7) serially against
`https://satrank.dev/api/intent`. Each agent gets a brief, makes 2–4
`call_intent` calls (paid 2 sats each via L402 self-pay through prod LND),
and emits a structured verdict block (indispensable / useful / nice_to_have
/ superfluous / harmful). Results land in `runs/<SIM_RUN>/verdicts.json`.

## One-time install

```bash
cd scripts/sim
npm install
```

## Running a sim

```bash
ANTHROPIC_API_KEY=sk-... \
  SIM_RUN=v3-sim-N \
  node v3-runner.mjs
```

Optional env:

| Var | Default | Notes |
|---|---|---|
| `SIM_PERSONAS` | `personas-v3.json` | Path to personas file |
| `SIM_MAX_TURNS` | 8 | Tool-use turns per agent |
| `SIM_MODEL` | `claude-opus-4-7` | Anthropic model id |
| `SIM_RUN` | `v3-sim-<timestamp>` | Run directory name |

## Output

Each agent's tool-use loop writes to `runs/<SIM_RUN>/verdicts.json`:

```json
[
  {
    "idx": 1,
    "persona": "LightningDataMiner — agent that needs Lightning network data",
    "output": "=== V3 SIM AGENT 1 VERDICT === verdict: useful ..."
  }
]
```

Aggregate with `aggregate.mjs` to produce a `summary.md` with the
distribution + pay_2xx rate:

```bash
SIM_RUN=v3-sim-N node aggregate.mjs
```

## Files

- `v3-runner.mjs` — orchestrator (serial agent execution to avoid
  the per-IP rate limit on /api/intent).
- `v3-intent-wrapper.mjs` — calls /api/intent end-to-end including
  paying the L402 invoice via prod LND `/v2/router/send` with
  `allow_self_payment: true`.
- `personas-v3.json` — 5 default personas (configurable).
- `aggregate.mjs` — reads `verdicts.json`, writes `summary.md`.

## Why serial, not parallel

`/api/intent` rate-limits 30 req/min/IP. Five agents in `Promise.all`
firing 2–4 calls each from the same source IP burst past the limit
within seconds. Sim 1 demonstrated this. Sim 2 onwards uses serial
execution inside `v3-runner.mjs`.

`runs/<SIM_RUN>/` and `node_modules/` are gitignored.
