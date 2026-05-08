# Install — SatRank L402 skill

## Option A — One-line MCP install (recommended)

Adds the 27 SatRank tools natively to Claude Code (or any MCP-aware agent
runtime) :

```bash
claude mcp add satrank -- npx -y satrank-mcp
```

Then SatRank tools (`satrank.intent`, `satrank.fulfill`, etc.) are
auto-discoverable and the skill instructions in `SKILL.md` apply directly.

## Option B — Skill only, no MCP (CLI agents)

Place the skill folder where your agent runtime reads SKILL files :

```bash
# Claude Code skills directory
mkdir -p ~/.config/claude/skills
cp -r claude-skills/satrank-l402 ~/.config/claude/skills/

# OR clone directly
cd ~/.config/claude/skills
git clone --depth=1 https://github.com/proofoftrust21/satrank.git satrank-tmp
mv satrank-tmp/claude-skills/satrank-l402 .
rm -rf satrank-tmp
```

The skill uses raw `curl` calls — works without any MCP dependency. Less
ergonomic but zero install footprint.

## Option C — Aperture client (`lnget`) without the audit trail

If you already have `lnget` installed and don't need the audit trail, you
can skip this skill entirely and call paid endpoints directly :

```bash
lnget --max-cost 20 https://satrank.dev/api/mini-llm/classify
```

This skill is most valuable when the audit trail (Ed25519 receipt + L1
anchor) matters — i.e. compliance, regulator-facing, or multi-step agent
flows where a refund path could trigger.

## Distribution

- **Source repo** : https://github.com/proofoftrust21/satrank/tree/main/claude-skills/satrank-l402
- **MCP server** : npm `satrank-mcp`, smithery `proofoftrust21/satrank`,
  Glama `proofoftrust21/satrank`, MCP registry pending
- **Hosted SatRank API** : https://satrank.dev (production, public)

## Security notes

- The skill performs `curl` against `https://satrank.dev` only ; nothing is
  sent to `localhost` / private IPs (SatRank's SSRF guard would reject it
  anyway).
- NIP-98 authentication uses ephemeral Nostr keypairs ; private key never
  leaves the agent process.
- Lightning payments go through the agent's configured wallet (lnd / NWC /
  Phoenix / Alby). SatRank never custodies sats.
- Evidence receipts are cryptographically self-verifying offline against
  the published `/.well-known/satrank-key`.

## Issues / contributions

- Bug reports : https://github.com/proofoftrust21/satrank/issues
- Roadmap : `docs/AEPS.md`, `docs/MCP.md`
- Doctrine : Bitcoin-pure, Lightning-native, no x402/EVM ever.
