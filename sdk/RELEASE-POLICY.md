# @satrank/sdk release policy

_Supply-chain hardening — last updated 2026-04-16._

## Pre-publish checklist

Every release MUST pass these checks before `npm publish`:

1. **No lifecycle scripts on install** — inspect `package.json` scripts field:
   - Allowed: `build`, `prepublishOnly`, `test`, `lint`
   - Prohibited: `preinstall`, `install`, `postinstall` (these execute on every consumer's machine)
   - Verify: `jq '.scripts' package.json` shows only allowed keys
2. **`files` whitelist** — confirm only `dist/` and `README.md` ship. Run `npm pack --dry-run` and check the file list.
3. **Build is reproducible** — `rm -rf dist && npm run build` before pack.
4. **Test suite green** — `npm test` from the repo root (the SDK shares tests with main).
5. **Version bumped** — no silent overwrite (npm blocks anyway but catch the mistake early).
6. **Changelog entry** — note the user-visible delta in `CHANGELOG.md` (create if missing).

## Publish command

```bash
cd sdk
npm pack --dry-run   # review file list — NO .env, NO credentials, NO source maps beyond dist
npm publish --access public --otp=<authenticator code>
```

- `--otp` proves 2FA is enabled on the publisher's npm account.
- `--access public` is required for scoped packages (`@satrank/*`).

## 2FA enforcement

The npm publisher account MUST have **auth-and-writes** 2FA enabled:

```bash
npm profile get          # verify
npm profile enable-2fa auth-and-writes   # if not already
```

This forces a TOTP challenge on every publish, closing the stolen-token risk.

## Typosquatting countermeasures

Non-scope names that could confuse users are registered as empty shells pointing back to `@satrank/sdk`:

- `satrank`
- `sat-rank-sdk`
- `satrank-client`

Each publishes a single `index.js` with a deprecation notice redirecting to the real scoped package. If any of these get "unpublished" (npm rules allow self-unpublish within 72h), a new one is published by the `@satrank` scope owner before the window closes.

## Post-publish verification

Every release is independently verified from a clean environment:

```bash
mkdir /tmp/verify && cd /tmp/verify
npm init -y
npm install @satrank/sdk@<version>
# Inspect the installed tree
ls node_modules/@satrank/sdk/dist
# Check nothing exfiltrated during install (no network calls beyond registry)
```

## Incident response

If a malicious package is ever published under a similar name:

1. Open npm security report: https://www.npmjs.com/support → "Report a package".
2. Tweet/blog the advisory with the malicious name spelled out.
3. Check existing users via `npm search` / GitHub for dependent projects.
4. File a GitHub Security Advisory on the satrank repo linking to the npm report.

## Revocation

If the npm token is ever suspected compromised:

```bash
npm token revoke <token-id>
# Rotate 2FA recovery codes
npm profile get  # verify no pending publishes
```

Rotate immediately any tokens visible in `~/.npmrc`, CI secrets, or local shell history.
