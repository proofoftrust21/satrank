#!/usr/bin/env bash
# Build the npm publish bundle for satrank-mcp from compiled dist.
#
# Output: mcp-pkg/ — a self-contained tree ready for `npm publish`.
# Inputs: requires `npm run build` to have produced dist/mcp/server-public.js
#         and dist/utils/assertionVerifier.js.
#
# The slim public MCP server (server-public.ts) is HTTP-only and proxies
# everything to SATRANK_API_BASE (default https://satrank.dev), so the
# published package has zero DB/LND dependency.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$ROOT/mcp-pkg"
VERSION="${1:-1.0.0}"

cd "$ROOT"

if [ ! -f "dist/mcp/server-public.js" ]; then
  echo "error: dist/mcp/server-public.js missing — run \`npm run build\` first" >&2
  exit 1
fi

rm -rf "$PKG_DIR"
mkdir -p "$PKG_DIR/dist/mcp" "$PKG_DIR/dist/utils"

cp dist/mcp/server-public.js "$PKG_DIR/dist/mcp/"
cp dist/mcp/server-public.js.map "$PKG_DIR/dist/mcp/" 2>/dev/null || true
cp dist/utils/assertionVerifier.js "$PKG_DIR/dist/utils/"
cp dist/utils/assertionVerifier.js.map "$PKG_DIR/dist/utils/" 2>/dev/null || true

# Prepend shebang so `npx satrank-mcp` works.
SERVER="$PKG_DIR/dist/mcp/server-public.js"
if ! head -1 "$SERVER" | grep -q '^#!/usr/bin/env node'; then
  printf '#!/usr/bin/env node\n%s' "$(cat "$SERVER")" > "$SERVER.new"
  mv "$SERVER.new" "$SERVER"
fi
chmod +x "$SERVER"

cp docs/MCP.md "$PKG_DIR/README.md"

cat > "$PKG_DIR/package.json" <<EOF
{
  "name": "satrank-mcp",
  "version": "$VERSION",
  "description": "SatRank MCP server — trust + audit + commerce primitives for AI agents on Bitcoin Lightning. 17 tools : intent, fulfill, mini-LLM, AEPS L1 anchor, disputes, evidence receipts. Bitcoin-pure, no x402/EVM.",
  "bin": {
    "satrank-mcp": "dist/mcp/server-public.js"
  },
  "files": [
    "dist/",
    "README.md"
  ],
  "keywords": [
    "mcp",
    "model-context-protocol",
    "lightning",
    "bitcoin",
    "l402",
    "agent",
    "satrank",
    "trust-oracle",
    "aeps",
    "lightning-network"
  ],
  "author": "SatRank",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/proofoftrust21/satrank.git"
  },
  "homepage": "https://satrank.dev",
  "bugs": {
    "url": "https://github.com/proofoftrust21/satrank/issues"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.24.2",
    "nostr-tools": "^2.23.3",
    "@noble/curves": "^2.0.1",
    "@noble/hashes": "^1.8.0"
  }
}
EOF

echo "ok: $PKG_DIR built (version $VERSION)"
echo "next: cd $PKG_DIR && npm pack --dry-run   # verify"
echo "      cd $PKG_DIR && npm publish --access public"
