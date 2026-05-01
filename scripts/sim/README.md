# SatRank simulation harness

Runs N agent personas in parallel via the Anthropic Messages API to test indispensability criteria. Each agent gets a brief, executes calls against `https://satrank.dev/api/fulfill`, and emits a structured verdict block. The aggregator computes the GO/NO-GO matrix.

## One-time install
```bash
cd scripts/sim
npm install
```

## Run a sim

```bash
# 1. Pick a run id (any string; defaults to today's date)
export SIM_RUN=sim-11

# 2. Generate keys + seed token_balance (uses SSH to root@178.104.108.108 ; override via SATRANK_SSH=...)
node scripts/sim/setup.mjs

# 3. Launch (need an Anthropic API key in env; do NOT paste it in chat)
export ANTHROPIC_API_KEY=sk-ant-api03-...
node scripts/sim/runner.mjs

# 4. Aggregate
node scripts/sim/aggregate.mjs
```

Outputs in `runs/<SIM_RUN>/`:
- `keys/<idx>.bin` — per-agent ephemeral Nostr private keys (gitignored)
- `agents.json` — registry: idx → pubkey
- `verdicts.json` — full per-agent transcripts + verdicts
- `summary.md` — aggregated GO/NO-GO matrix + per-agent table

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `SIM_RUN` | (required) | Run id; outputs go in `runs/<SIM_RUN>/` |
| `ANTHROPIC_API_KEY` | (required for runner) | API key. Use shell `export`, never paste in chat |
| `SIM_MODEL` | `claude-opus-4-7` | Anthropic model |
| `SIM_MAX_TURNS` | `14` | Hard cap per agent |
| `SIM_PER_TURN_TOKENS` | `8192` | max_tokens per response |
| `SIM_NUM` | `11` | Display number in verdict header (`SIM 11 AGENT N`) |
| `SIM_SEED_SATS` | `100` | Pre-credited token_balance per agent |
| `SATRANK_SSH` | `root@178.104.108.108` | SSH target for setup seed step |
| `SATRANK_BASE` | `https://satrank.dev` | API base for fulfill calls |

## Personas

Edit `personas.json` to change agent count, mission briefs, category hints, sat caps, latency budgets. The runner reads this at startup; no code changes needed.

## Cost
- ~$2-5 per run (10 agents × Opus 4.7 × ~50k tokens/agent)
- ~10-20 minutes wall clock
- ~$5-30 in real sats (sat-spent on real L402 endpoints during fulfill)

## Anti-fail2ban discipline
The setup step batches the DB seed into a single SSH session (single heredoc). Avoid hammering with parallel SSH calls during a sim; the per-IP discoveryRateLimit on prod is 10/min and an aggressive harness can trip fail2ban (observed Phase 6.1 smoke).
